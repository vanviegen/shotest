import A from 'aberdeen';
import * as route from 'aberdeen/route';

type ConsoleTone = 'error' | 'warning' | 'info' | 'debug' | 'log';
type StepChange = 'changed' | 'unchanged' | 'removed' | 'new';

interface ConsoleMessageInfo {
  type?: string;
  text?: string;
  source?: string;
}

interface TestSummary {
  name: string;
  file: string;
  line: number;
  title: string;
  status: string;
  hasChanges: boolean;
}

interface TestManifest {
  file: string;
  title: string;
  error?: string;
  errorSource?: string;
  errorStack?: string;
}

interface ReviewStep {
  acceptedImage?: string;
  currentImage?: string;
  location: string;
  duration?: number;
  role?: string;
  consoleMessages?: ConsoleMessageInfo[];
  changed: boolean;
}

interface TestDetail {
  manifest: TestManifest | null;
  steps: ReviewStep[];
}

interface ReviewState {
  tests: TestSummary[];
  selected: string | null;
  detail: TestDetail | null;
  loadingTests: boolean;
  loadingDetail: boolean;
  scale: number;
  showNew: boolean;
}

const state = A.proxy<ReviewState>({
  tests: [],
  selected: null,
  detail: null,
  loadingTests: true,
  loadingDetail: false,
  scale: 0.8,
  showNew: true,
});

let pendingSelectionToken = 0;

setInterval(() => {
  state.showNew = false;
  setTimeout(() => {
    state.showNew = true;
  }, 500);
}, 1500);

function pathForTest(name: string | null): string {
  return name ? `/test/${encodeURIComponent(name)}` : '/';
}

function routeTestName(): string | null {
  return route.current.p[0] === 'test' && route.current.p.length > 1
    ? decodeURIComponent(route.current.p.slice(1).join('/'))
    : null;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  return response.json() as Promise<T>;
}

async function fetchTests(): Promise<void> {
  state.loadingTests = true;

  try {
    const tests = await fetchJson<TestSummary[]>('/api/tests');
    tests.sort((a, b) =>
      a.file.localeCompare(b.file)
      || a.line - b.line
      || a.title.localeCompare(b.title),
    );

    state.tests = [];
    for (const test of tests) {
      state.tests.push(test);
    }

    const wanted = routeTestName();
    if (wanted && tests.some((test) => test.name === wanted)) {
      await selectTest(wanted, false);
    } else if (state.selected && !tests.some((test) => test.name === state.selected)) {
      deselectTest(false);
    }
  } finally {
    state.loadingTests = false;
  }
}

async function selectTest(name: string, updateRoute = true): Promise<void> {
  if (updateRoute && route.current.path !== pathForTest(name)) {
    route.go(pathForTest(name));
  }

  if (state.selected === name && state.detail) {
    return;
  }

  state.selected = name;
  state.detail = null;
  state.loadingDetail = true;
  const token = ++pendingSelectionToken;
  try {
    const detail = await fetchJson<TestDetail>(`/api/test/${encodeURIComponent(name)}`);
    if (token === pendingSelectionToken && state.selected === name) {
      state.detail = detail;
    }
  } finally {
    if (token === pendingSelectionToken && state.selected === name) {
      state.loadingDetail = false;
    }
  }
}

async function acceptChanges(name: string): Promise<void> {
  await fetch(`/api/accept/${encodeURIComponent(name)}`, { method: 'POST' });
  deselectTest();
  await fetchTests();
}

function deselectTest(updateRoute = true): void {
  pendingSelectionToken++;
  state.selected = null;
  state.detail = null;
  state.loadingDetail = false;
  if (updateRoute && route.current.path !== '/') {
    route.go('/');
  }
}

function parseLine(location: string): string {
  const index = location.lastIndexOf(':');
  return index >= 0 ? location.slice(index + 1) : '?';
}

function formatDuration(duration?: number): string {
  if (typeof duration !== 'number' || !Number.isFinite(duration)) {
    return 'n/a';
  }
  return `${Math.max(0, Math.round(duration))}ms`;
}

function durationClass(duration?: number): 'unknown' | 'danger' | 'warn' | 'ok' {
  if (typeof duration !== 'number' || !Number.isFinite(duration)) {
    return 'unknown';
  }
  if (duration > 3000) {
    return 'danger';
  }
  if (duration > 500) {
    return 'warn';
  }
  return 'ok';
}

function renderRoleChrome(step: ReviewStep): void {
  if (!step.role) {
    return;
  }

  A('div.step-topbar', () => {
    A('span.step-role-badge', () => {
      A('span.role-label #role');
      A(`span.role-name #${step.role}`);
    });
  });
}

function consoleTone(type?: string): ConsoleTone {
  if (type === 'error' || type === 'assert') {
    return 'error';
  }
  if (type === 'warning' || type === 'warn') {
    return 'warning';
  }
  if (type === 'info') {
    return 'info';
  }
  if (type === 'debug' || type === 'trace') {
    return 'debug';
  }
  return 'log';
}

function summarizeConsoleMessages(messages: ConsoleMessageInfo[]): Array<{ tone: ConsoleTone; count: number }> {
  const counts: Record<ConsoleTone, number> = {
    error: 0,
    warning: 0,
    info: 0,
    debug: 0,
    log: 0,
  };

  for (const message of messages) {
    counts[consoleTone(message.type)]++;
  }

  return (['error', 'warning', 'info', 'debug', 'log'] as ConsoleTone[])
    .filter((tone) => counts[tone] > 0)
    .map((tone) => ({ tone, count: counts[tone] }));
}

function renderConsoleMessages(step: ReviewStep): void {
  const messages = step.consoleMessages ?? [];
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
        A(`span.console-summary-part.${part.tone} #${part.count} ${part.tone}`);
      });
    });

    A('div.console-message-list', () => {
      for (const message of messages) {
        const tone = consoleTone(message.type);
        A(`div.console-message.${tone}`, () => {
          A(`span.console-type #${String(message.type || 'log')}`);
          A(`span.console-text #${String(message.text || '')}`);
          if (message.source) {
            A(`div.console-source #${message.source}`);
          }
        });
      }
    });
  });
}

function getStepChange(step: ReviewStep): StepChange {
  if (!step.acceptedImage) {
    return 'new';
  }
  if (!step.currentImage) {
    return 'removed';
  }
  return step.changed ? 'changed' : 'unchanged';
}

A(() => {
  const wanted = routeTestName();
  if (!wanted) {
    if (state.selected) {
      deselectTest(false);
    }
    return;
  }

  if (wanted !== state.selected && state.tests.some((test) => test.name === wanted)) {
    void selectTest(wanted, false);
  }
});

const listEl = document.getElementById('test-list');
const detailEl = document.getElementById('test-detail');

if (!listEl || !detailEl) {
  throw new Error('Review UI root elements are missing.');
}

A(listEl, () => {
  A('div.list-toolbar display:flex', () => {
    A('h2 flex:1 #ShoTest');
    A(() => {
      if (state.loadingTests) {
        A('div.loading-chip', () => {
          A('span.loading-spinner');
          A('span #Loading');
        });
      }
    });
    A('label.scale-control', () => {
      A('span #scale');
      A('input type=range min=0.1 max=1 step=0.01 bind=', A.ref(state, 'scale'));
      A('span.scale-value', () => {
        A('#', `${Math.round(state.scale * 100)}%`);
      });
    });
  });

  const selectedLookup = A.derive(() => (
    state.selected ? ({ [state.selected]: true } as Record<string, boolean>) : {}
  )).value;
  A(() => {
    if (state.loadingTests && state.tests.length === 0) {
      A('div.list-status', () => {
        A('span.loading-spinner.large');
        A('span #Loading tests…');
      });
      return;
    }

    if (state.tests.length === 0) {
      A('div.list-status #No tests found');
      return;
    }

    let currentFile: string | null = null;

    A.onEach(state.tests, (test) => {
      if (test.file !== currentFile) {
        currentFile = test.file;
        A(`div.file-header #${test.file}`);
      }

      const isFailed = test.status === 'failed' || test.status === 'timedOut';
      const dotClass = test.hasChanges ? 'orange' : isFailed ? 'neutral' : 'green';
      A('div.test-item .selected=', A.ref(selectedLookup, test.name), 'click=', () => {
        if (selectedLookup[test.name]) {
          deselectTest();
        } else {
          void selectTest(test.name);
        }
      }, () => {
        A(`div.dot.${dotClass}`);
        A(`span.title${isFailed ? '.failed' : ''} #${test.title}`);
      });
    });
  });
});

A(detailEl, () => {
  A(() => {
    if (!state.selected) {
      detailEl.className = 'empty';
      A('span #Select a test from the list');
      return;
    }

    if (state.loadingDetail || !state.detail) {
      detailEl.className = 'empty';
      A('div.loading-panel', () => {
        A('span.loading-spinner.large');
        A('span #Loading test…');
      });
      return;
    }

    detailEl.className = '';

    const detail = state.detail;
    const manifest = detail.manifest;
    const steps = detail.steps;

    if (manifest) {
      A('h3', 'color: var(--fg2); font-size: 13px;', () => {
        A(`span #${manifest.file} — `);
        A('span', 'color: var(--fg);', `#${manifest.title}`);
      });
    }

    A('div.steps-grid', () => {
      for (const step of steps) {
        const line = parseLine(step.location);
        const durationText = formatDuration(step.duration);
        const durationSeverity = durationClass(step.duration);
        const change = getStepChange(step);

        A(`div.step.${change}`, () => {
          renderRoleChrome(step);
          A('div.step-body', () => {
            if (change === 'changed') {
              const mouseShowNew = A.proxy<{ value?: boolean }>({ value: undefined });

              function onMouseMove(event: MouseEvent): void {
                const target = event.currentTarget;
                if (!(target instanceof HTMLElement)) {
                  return;
                }
                const box = target.getBoundingClientRect();
                mouseShowNew.value = event.clientX - box.left > box.width / 2;
              }

              function onMouseLeave(): void {
                mouseShowNew.value = undefined;
              }

              const showNew = A.derive(() => mouseShowNew.value ?? state.showNew);
              A('div.image-stage.compare-view', '$zoom=', state.scale, 'mousemove=', onMouseMove, 'mouseleave=', onMouseLeave, () => {
                A('img.compare-layer .visible', 'src=', `/image/accepted/${encodeURIComponent(state.selected!)}${`/${step.acceptedImage!}`}`);
                A('img.compare-layer .visible=', showNew, 'src=', `/image/current/${encodeURIComponent(state.selected!)}${`/${step.currentImage!}`}`);
              });
              A('div.label', () => {
                A(`span #line ${line} `);
                A(`span #${String.fromCharCode(8226)} `);
                A(`span.duration.${durationSeverity} #${durationText} `);
                A(`span #${String.fromCharCode(8226)} ${change} ${String.fromCharCode(8226)} showing ${showNew.value ? 'current' : 'accepted'}`);
              });
              renderConsoleMessages(step);
            } else {
              const imageName = step.currentImage || step.acceptedImage;
              if (imageName) {
                const imageKind = step.currentImage ? 'current' : 'accepted';
                const imageSrc = `/image/${imageKind}/${encodeURIComponent(state.selected!)}${`/${imageName}`}`;
                A('div.image-stage', '$zoom=', state.scale, () => {
                  A('img src=', imageSrc);
                });
              }
              A('div.label', () => {
                A(`span #line ${line} `);
                A(`span #${String.fromCharCode(8226)} `);
                A(`span.duration.${durationSeverity} #${durationText} `);
                A(`span #${String.fromCharCode(8226)} ${change}`);
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

    if (manifest?.error) {
      A('div.error-box', () => {
        A(`div #${manifest.error}`);
        if (manifest.errorSource) {
          A(`div.error-source #${manifest.errorSource}`);
        }
        if (manifest.errorStack) {
          A(`pre.error-stack #${manifest.errorStack}`);
        }
      });
    }

    const hasAnyChanges = steps.some((step) => step.changed || (!step.acceptedImage && step.currentImage) || (step.acceptedImage && !step.currentImage));
    if (hasAnyChanges) {
      A('button.accept-btn #Accept visuals', 'click=', () => {
        void acceptChanges(state.selected!);
      });
    }
  });
});

void fetchTests();