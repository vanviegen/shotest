import A from 'aberdeen';
import * as route from 'aberdeen/route';

const state = A.proxy({
    tests: [],
    selected: null,
    detail: null,
    scale: 0.8,
    switchState: true,
});

let pendingSelectionToken = 0;
setInterval(() => {
    state.switchState = false;
    setInterval(() => state.switchState = true, 500);
}, 1500);

function pathForTest(name) {
    return name ? '/test/' + encodeURIComponent(name) : '/';
}

function routeTestName() {
    return route.current.p[0] === 'test' && route.current.p.length > 1
        ? decodeURIComponent(route.current.p.slice(1).join('/'))
        : null;
}

async function fetchTests() {
    const res = await fetch('/api/tests');
    const tests = await res.json();
    tests.sort((a, b) =>
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        a.title.localeCompare(b.title)
    );
    state.tests = [];
    for (const t of tests) state.tests.push(t);

    const wanted = routeTestName();
    if (wanted && tests.some(t => t.name === wanted)) {
        await selectTest(wanted, false);
    } else if (state.selected && !tests.some(t => t.name === state.selected)) {
        deselectTest(false);
    }
}

async function selectTest(name, updateRoute = true) {
    if (updateRoute && route.current.path !== pathForTest(name)) {
        route.go(pathForTest(name));
    }

    if (state.selected === name && state.detail) return;

    state.selected = name;
    state.detail = null;
    const token = ++pendingSelectionToken;
    const res = await fetch('/api/test/' + encodeURIComponent(name));
    const detail = await res.json();
    if (token === pendingSelectionToken && state.selected === name) {
        state.detail = detail;
    }
}

async function acceptChanges(name) {
    await fetch('/api/accept/' + encodeURIComponent(name), { method: 'POST' });
    deselectTest();
    await fetchTests();
}

function deselectTest(updateRoute = true) {
    pendingSelectionToken++;
    state.selected = null;
    state.detail = null;
    if (updateRoute && route.current.path !== '/') {
        route.go('/');
    }
}

A(() => {
    const wanted = routeTestName();
    if (!wanted) {
        if (state.selected) deselectTest(false);
        return;
    }
    if (wanted !== state.selected && state.tests.some(t => t.name === wanted)) {
        selectTest(wanted, false);
    }
});

// Mount test list
const listEl = document.getElementById('test-list');
A(listEl, () => {
    A('div.list-toolbar display:flex', () => {
        A('h2 flex:1 #shoTest');
        A('label.scale-control', () => {
            A('span #scale');
            A('input type=range min=0.1 max=1 step=0.01 bind=', A.ref(state, 'scale'));
            A('span.scale-value', () => {
                A('#', Math.round(state.scale * 100) + '%');
            });
        });
    });

    const selObj = A.derive(() => ({ [state.selected]: true })).value;
    let currentFile = null;

    A.onEach(state.tests, (test) => {
        if (test.file !== currentFile) {
            currentFile = test.file;
            A('div.file-header #' + test.file);
        }

        const isFailed = test.status === 'failed' || test.status === 'timedOut';
        const dotClass = test.hasChanges ? 'orange' : isFailed ? 'neutral' : 'green';
        A('div.test-item .selected=', A.ref(selObj, test.name), 'click=', () => selObj[test.name] ? deselectTest() : selectTest(test.name), () => {
            A('div.dot.' + dotClass);
            A('span.title' + (isFailed ? '.failed' : ''), '#' + test.title);
        });
    });
});

// Mount test detail
const detailEl = document.getElementById('test-detail');
A(detailEl, () => {
    A(() => {
        if (!state.selected) {
            detailEl.className = 'empty';
            A('span #Select a test from the list');
            return;
        }

        if (!state.detail) {
            detailEl.className = 'empty';
            A('span #Loading test…');
            return;
        }

        detailEl.className = '';

        const detail = state.detail;
        const manifest = detail.manifest;
        const steps = detail.steps;

        if (manifest) {
            A('h3', 'color: var(--fg2); font-size: 13px;', () => {
                A('span #' + manifest.file + ' — ');
                A('span', 'color: var(--fg);', '#' + manifest.title);
            });
        }

        A('div.steps-grid', () => {
            for (const step of steps) {
                
                const change = step.acceptedImage ? (step.currentImage ? (step.changed ? 'changed' : 'unchanged') : 'removed') : 'new';
                A(`div.step.${change}`, () => {
                    
                    if (change === 'changed') {
                        let mouseState = A.proxy();
                        function onMouseMove(event) {
                            const box = event.currentTarget.getBoundingClientRect();
                            mouseState.value = event.clientX - box.left > box.width / 2; // true for 'current', false for 'accepted'
                        }
                        function onMouseLeave() {
                            mouseState.value = undefined;
                        }
                        const switchState = A.derive(() => mouseState.value ?? state.switchState);
                        A('div.image-stage.compare-view', '$zoom=', state.scale, 'mousemove=', onMouseMove, 'mouseleave=', onMouseLeave, () => {
                            A('img.compare-layer', 'src=', '/image/expected/' + encodeURIComponent(state.selected) + '/' + step.acceptedImage);
                            A('img.compare-layer .visible=', switchState, 'src=', '/image/current/' + encodeURIComponent(state.selected) + '/' + step.currentImage);
                        });
                        A(`div.label`, () => {
                            A(`#line ${step.location.split(':')[1]} • ${change} • showing ${switchState.value ? 'current' : 'accepted'}`);
                        });
                    } else {
                        const img = step.currentImage || step.acceptedImage;
                        if (img) {
                            const src = '/image/' + (step.currentImage ? 'current' : 'accepted') + '/' + encodeURIComponent(state.selected) + '/' + img;
                            A('div.image-stage', '$zoom=', state.scale, () => {
                                A('img src=', src);
                            });
                        }
                        A(`div.label #line ${step.location.split(':')[1]} • ${change}`);
                    }
                });
            }
        });

        if (manifest && manifest.error) {
            A('div.error-box', () => {
                A('div #' + manifest.error);
                if (manifest.errorSource) {
                    A('div.error-source #' + manifest.errorSource);
                }
                if (manifest.errorStack) {
                    A('pre.error-stack #' + manifest.errorStack);
                }
            });
        }

        const hasAnyChanges = steps.some(s => s.changed || (!s.acceptedImage && s.currentImage) || (s.acceptedImage && !s.currentImage));
        if (hasAnyChanges) {
            A('button.accept-btn #Accept visuals', 'click=', () => acceptChanges(state.selected));
        }
    });
});

fetchTests();
