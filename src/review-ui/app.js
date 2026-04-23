import A from 'aberdeen';
import * as route from 'aberdeen/route';

const state = A.proxy({
    tests: [],
    selected: null,
    detail: null,
    scale: 0.8,
    showNew: true,
});

let pendingSelectionToken = 0;
setInterval(() => {
    state.showNew = false;
    setTimeout(() => state.showNew = true, 500);
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

function parseLine(location) {
    const idx = location.lastIndexOf(':');
    return idx >= 0 ? location.slice(idx + 1) : '?';
}

function formatDuration(duration) {
    if (typeof duration !== 'number' || !Number.isFinite(duration)) return 'n/a';
    return Math.max(0, Math.round(duration)) + 'ms';
}

function durationClass(duration) {
    if (typeof duration !== 'number' || !Number.isFinite(duration)) return 'unknown';
    if (duration > 3000) return 'danger';
    if (duration > 500) return 'warn';
    return 'ok';
}

function renderRoleChrome(step) {
    if (!step.role) return;
    A('div.step-topbar', () => {
        A('span.step-role-badge', () => {
            A('span.role-label #role');
            A('span.role-name #' + step.role);
        });
    });
}

function consoleTone(type) {
    if (type === 'error' || type === 'assert') return 'error';
    if (type === 'warning' || type === 'warn') return 'warning';
    if (type === 'info') return 'info';
    if (type === 'debug' || type === 'trace') return 'debug';
    return 'log';
}

function summarizeConsoleMessages(messages) {
    const counts = {
        error: 0,
        warning: 0,
        info: 0,
        debug: 0,
        log: 0,
    };

    for (const message of messages) {
        counts[consoleTone(message.type)]++;
    }

    return ['error', 'warning', 'info', 'debug', 'log']
        .filter((tone) => counts[tone] > 0)
        .map((tone) => ({ tone, count: counts[tone] }));
}

function renderConsoleMessages(step) {
    const messages = step.consoleMessages || [];
    const summary = summarizeConsoleMessages(messages);

    if (messages.length === 0) {
        A('div.console-messages.empty', () => {
            A('div.console-summary.empty', () => {
                A('span.console-summary-part.none #no messages');
            });
        });
        return;
    }

    A('details.console-messages', () => {
        A('summary.console-summary', () => {
            summary.forEach((part, index) => {
                if (index > 0) {
                    A('span.console-summary-separator #|');
                }
                A('span.console-summary-part.' + part.tone + ' #' + part.count + ' ' + part.tone);
            });
        });

        A('div.console-message-list', () => {
            for (const message of messages) {
                const tone = consoleTone(message.type);
                A('div.console-message.' + tone, () => {
                    A('span.console-type #' + String(message.type || 'log'));
                    A('span.console-text #' + String(message.text || ''));
                    if (message.source) {
                        A('div.console-source #' + message.source);
                    }
                });
            }
        });
    });
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
        A('h2 flex:1 #ShoTest');
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
                const line = parseLine(step.location);
                const durationText = formatDuration(step.duration);
                const durationSeverity = durationClass(step.duration);
                const change = step.acceptedImage ? (step.currentImage ? (step.changed ? 'changed' : 'unchanged') : 'removed') : 'new';
                A(`div.step.${change}`, () => {
                    renderRoleChrome(step);
                    A('div.step-body', () => {
                        if (change === 'changed') {
                            let mouseShowNew = A.proxy();
                            function onMouseMove(event) {
                                const box = event.currentTarget.getBoundingClientRect();
                                mouseShowNew.value = event.clientX - box.left > box.width / 2;
                            }
                            function onMouseLeave() {
                                mouseShowNew.value = undefined;
                            }
                            A(() => {
                                console.log('showNew', mouseShowNew.value, state.showNew);
                            });
                            const showNew = A.derive(() => mouseShowNew.value ?? state.showNew);
                            A('div.image-stage.compare-view', '$zoom=', state.scale, 'mousemove=', onMouseMove, 'mouseleave=', onMouseLeave, () => {
                                A('img.compare-layer .visible', 'src=', '/image/accepted/' + encodeURIComponent(state.selected) + '/' + step.acceptedImage);
                                A('img.compare-layer .visible=', showNew, 'src=', '/image/current/' + encodeURIComponent(state.selected) + '/' + step.currentImage);
                            });
                            A('div.label', () => {
                                A('span #line ' + line + ' ');
                                A('span #' + String.fromCharCode(8226) + ' ');
                                A('span.duration.' + durationSeverity + ' #' + durationText + ' ');
                                A('span #' + String.fromCharCode(8226) + ' ' + change + ' ' + String.fromCharCode(8226) + ' showing ' + (showNew.value ? 'current' : 'accepted'));
                            });
                            renderConsoleMessages(step);
                        } else {
                            const img = step.currentImage || step.acceptedImage;
                            if (img) {
                                const src = '/image/' + (step.currentImage ? 'current' : 'accepted') + '/' + encodeURIComponent(state.selected) + '/' + img;
                                A('div.image-stage', '$zoom=', state.scale, () => {
                                    A('img src=', src);
                                });
                            }
                            A('div.label', () => {
                                A('span #line ' + line + ' ');
                                A('span #' + String.fromCharCode(8226) + ' ');
                                A('span.duration.' + durationSeverity + ' #' + durationText + ' ');
                                A('span #' + String.fromCharCode(8226) + ' ' + change);
                            });
                            renderConsoleMessages(step);
                        }
                    });
                });
            }
        });
        if (steps.length === 0) {
            A('div', 'color: var(--fg2); font-size: 14px; padding: 16px 0;', '#No screenshots taken');
        }

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