import A from 'aberdeen';
 
const state = A.proxy({
    tests: [],
    selected: null,
    detail: null,
});

async function fetchTests() {
    const res = await fetch('/api/tests');
    const tests = await res.json();
    state.tests.length = 0;
    for (const t of tests) state.tests.push(t);
}

async function selectTest(name) {
    state.selected = name;
    const res = await fetch('/api/test/' + encodeURIComponent(name));
    state.detail = await res.json();
}

async function acceptChanges(name) {
    await fetch('/api/accept/' + encodeURIComponent(name), { method: 'POST' });
    await fetchTests();
    // Re-select to refresh detail with updated state
    await selectTest(name);
}

function deselectTest() {
    state.selected = null;
    state.detail = null;
}

// Mount test list
const listEl = document.getElementById('test-list');
A(listEl, () => {
    A('h2 #shoTest Review');
    const selObj = A.derive(() => ({[state.selected]: true})).value;
    A.onEach(state.tests, (test) => {
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
        if (!state.selected || !state.detail) {
            detailEl.className = 'empty';
            A('span #Select a test from the list');
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
        
        // Steps grid
        A('div.steps-grid', () => {
            for (const step of steps) {
                const isNew = !step.acceptedImage && step.currentImage;
                const isRemoved = step.acceptedImage && !step.currentImage;
                const cls = isNew ? '.new' : isRemoved ? '.removed' : step.changed ? '.changed' : '';
                A('div.step' + cls, () => {
                    if (step.changed || isNew || isRemoved) {
                        // Show both images side by side when they differ
                        A('div.images', () => {
                            if (step.acceptedImage) {
                                A('div', () => {
                                    A('img src=/image/expected/' + encodeURIComponent(state.selected) + '/' + step.acceptedImage);
                                    A('div.img-label #accepted');
                                });
                            }
                            if (step.currentImage) {
                                A('div', () => {
                                    A('img src=/image/current/' + encodeURIComponent(state.selected) + '/' + step.currentImage);
                                    A('div.img-label #current');
                                });
                            }
                        });
                    } else if (step.currentImage) {
                        // Identical — show single image
                        A('div.images', () => {
                            A('div', () => {
                                A('img src=/image/current/' + encodeURIComponent(state.selected) + '/' + step.currentImage);
                            });
                        });
                    }
                    A('div.label #' + step.location);
                });
            }
        });
        
        // Error box
        if (manifest && manifest.error) {
            A('div.error-box #' + manifest.error);
        }
        
        // Accept button (if there are any changes)
        const hasAnyChanges = steps.some(s => s.changed || (!s.acceptedImage && s.currentImage) || (s.acceptedImage && !s.currentImage));
        if (hasAnyChanges) {
            A('button.accept-btn #Accept visual changes', 'click=', () => acceptChanges(state.selected));
        }
    });
});

// Initial fetch
fetchTests();
