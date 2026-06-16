import A from 'aberdeen';
import * as route from 'aberdeen/route';
import * as S from 'staffa';
import {
  camera,
  check,
  circleAlert,
  circleCheck,
  triangleAlert,
  undo2,
} from 'staffa/icons.js';

type ConsoleTone = 'error' | 'warning' | 'info' | 'debug' | 'log';
type StepChange = 'changed' | 'unchanged' | 'removed' | 'new';
type CompareMode = 'accepted' | 'current' | 'toggle';

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
  canRevert: boolean;
}

interface ReviewState {
  tests: TestSummary[];
  detail: TestDetail | null;
  loadingTests: boolean;
  loadingDetail: boolean;
  scale: number;
  compareMode: CompareMode;
  toggleShowNew: boolean;
}

const state = A.proxy<ReviewState>({
  tests: [],
  detail: null,
  loadingTests: true,
  loadingDetail: false,
  scale: 0.8,
  compareMode: 'toggle',
  toggleShowNew: true,
});

let detailToken = 0;

route.interceptLinks();

// Always use light mode.
S.setDarkMode(false);

// Drives the automatic flip in "toggle" compare mode.
setInterval(() => {
  state.toggleShowNew = false;
  setTimeout(() => {
    state.toggleShowNew = true;
  }, 500);
}, 1500);

// ── Scoped styles for the few custom bits Staffa doesn't cover ──────

const stageStyle = A.insertCss({
  '&': 'position:relative display:inline-grid overflow:hidden border-radius:4px background:#000',
  img: 'grid-area:1/1 display:block max-width:none border-radius:4px',
  '.layer': 'opacity:0 transition: opacity 120ms linear;',
  '.layer.visible': 'opacity:1',
});

const consoleStyle = A.insertCss({
  '&': 'width:100% font-size:0.8em margin-top:0.5rem',
  summary: 'cursor:pointer color:$s-muted user-select:none',
  '.list': 'display:flex flex-direction:column gap:0.4rem margin-top:0.4rem',
  '.msg': 'border-left: 3px solid $s-faint; border-radius:4px white-space:pre-wrap word-break:break-word pv:0.3rem ph:0.5rem font-family: ui-monospace, monospace;',
  '.msg.error': 'border-left-color:$s-danger color:$s-danger',
  '.msg.warning': 'border-left-color:$s-warning',
  '.type': 'text-transform:uppercase font-size:0.85em color:$s-muted margin-right:0.4rem',
  '.src': 'color:$s-muted margin-top:0.25rem word-break:break-all',
});

// A thin, borderless range slider in the brand colour. The filled portion is a
// `--fill`-sized gradient overlay on a faint track (set reactively for WebKit;
// Firefox fills `::-moz-range-progress` on its own).
const sliderStyle = A.insertCss({
  '&': 'appearance:none -webkit-appearance:none width:64px height:14px background:transparent cursor:pointer',
  '&::-webkit-slider-runnable-track': 'height:4px border-radius:99px background-color:$s-faint background-image: linear-gradient( $s-primary, $s-primary ); background-repeat:no-repeat; background-size: var(--fill, 0%) 100%;',
  '&::-webkit-slider-thumb': 'appearance:none -webkit-appearance:none width:13px height:13px margin-top:-5px border-radius:50% background:$s-primary',
  '&::-moz-range-track': 'height:4px border-radius:99px background:$s-faint',
  '&::-moz-range-progress': 'height:4px border-radius:99px background:$s-primary',
  '&::-moz-range-thumb': 'width:13px height:13px border:0 border-radius:50% background:$s-primary',
});

// ── Data loading ────────────────────────────────────────────────────

function routeTestName(): string | null {
  return route.current.p[0] === 'test' && route.current.p.length > 1
    ? decodeURIComponent(route.current.p.slice(1).join('/'))
    : null;
}

function hrefForTest(name: string): string {
  return `/test/${encodeURIComponent(name)}`;
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
    state.tests = tests;
  } finally {
    state.loadingTests = false;
  }
}

async function loadDetail(name: string): Promise<void> {
  state.detail = null;
  state.loadingDetail = true;
  const token = ++detailToken;
  try {
    const detail = await fetchJson<TestDetail>(`/api/test/${encodeURIComponent(name)}`);
    if (token === detailToken) {
      state.detail = detail;
    }
  } finally {
    if (token === detailToken) {
      state.loadingDetail = false;
    }
  }
}

async function acceptChanges(name: string): Promise<void> {
  const acceptedIndex = state.tests.findIndex((test) => test.name === name);
  await fetch(`/api/accept/${encodeURIComponent(name)}`, { method: 'POST' });
  await fetchTests();

  const next = findNextUnacceptedTestName(Math.max(0, acceptedIndex));
  route.go(next ? hrefForTest(next) : '/');
}

async function revertChanges(name: string): Promise<void> {
  state.detail = null;
  state.loadingDetail = true;
  await fetch(`/api/revert/${encodeURIComponent(name)}`, { method: 'POST' });
  await fetchTests();
  await loadDetail(name);
}

function findNextUnacceptedTestName(startIndex: number): string | null {
  const { tests } = state;
  for (let i = startIndex; i < tests.length; i += 1) {
    if (tests[i].hasChanges) return tests[i].name;
  }
  for (let i = 0; i < Math.min(startIndex, tests.length); i += 1) {
    if (tests[i].hasChanges) return tests[i].name;
  }
  return null;
}

// React to URL changes: (re)load the selected test's detail.
A(() => {
  const name = routeTestName();
  if (name) {
    void loadDetail(name);
  } else {
    detailToken++;
    state.detail = null;
    state.loadingDetail = false;
  }
});

// ── Helpers ─────────────────────────────────────────────────────────

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

function getStepChange(step: ReviewStep): StepChange {
  if (!step.acceptedImage) return 'new';
  if (!step.currentImage) return 'removed';
  return step.changed ? 'changed' : 'unchanged';
}

function selectedTestHasChanges(): boolean {
  const steps = state.detail?.steps ?? [];
  return steps.some((step) => getStepChange(step) !== 'unchanged');
}

function consoleTone(type?: string): ConsoleTone {
  if (type === 'error' || type === 'assert') return 'error';
  if (type === 'warning' || type === 'warn') return 'warning';
  if (type === 'info') return 'info';
  if (type === 'debug' || type === 'trace') return 'debug';
  return 'log';
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'color', 'file', 'radio', 'range', 'reset', 'submit'].includes(target.type);
  }
  return false;
}

function selectRelativeTest(offset: number): void {
  const { tests } = state;
  if (tests.length === 0) return;
  const selected = routeTestName();
  const currentIndex = selected
    ? tests.findIndex((test) => test.name === selected)
    : (offset > 0 ? -1 : tests.length);
  const nextIndex = Math.min(tests.length - 1, Math.max(0, currentIndex + offset));
  if (nextIndex !== currentIndex) {
    route.go(hrefForTest(tests[nextIndex].name));
  }
}

document.addEventListener('keydown', (event) => {
  if (isTextEntryTarget(event.target)) return;

  if (event.ctrlKey && !event.altKey && !event.metaKey) {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      selectRelativeTest(-1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      selectRelativeTest(1);
    }
    return;
  }

  if (event.altKey || event.metaKey || event.ctrlKey) return;

  const key = event.key.toLowerCase();
  const selected = routeTestName();

  if (key === 'o') { event.preventDefault(); state.compareMode = 'accepted'; }
  else if (key === 'n') { event.preventDefault(); state.compareMode = 'current'; }
  else if (key === 't') { event.preventDefault(); state.compareMode = 'toggle'; }
  else if (key === 'a' && selected && selectedTestHasChanges()) {
    event.preventDefault();
    void acceptChanges(selected);
  } else if (key === 'r' && selected && state.detail?.canRevert) {
    event.preventDefault();
    void revertChanges(selected);
  }
});

// ── Rendering ───────────────────────────────────────────────────────

function statusIcon(test: TestSummary): () => void {
  const failed = test.status === 'failed' || test.status === 'timedOut';
  if (test.hasChanges) return () => circleAlert({ size: '1.1em', color: 'var(--s-warning)' });
  if (failed) return () => triangleAlert({ size: '1.1em', color: 'var(--s-danger)' });
  return () => circleCheck({ size: '1.1em', color: 'var(--s-success)' });
}

function buildNavItems(): S.MenuEntry[] {
  const items: S.MenuEntry[] = [];
  let currentFile: string | null = null;
  for (const test of state.tests) {
    if (test.file !== currentFile) {
      currentFile = test.file;
      items.push(() => A('div font-size:0.8em font-weight:600 color:$s-muted mt:0.5rem mb:0.1rem #', test.file));
    }
    items.push({
      label: test.title,
      icon: statusIcon(test),
      href: hrefForTest(test.name),
    });
  }
  return items;
}

function renderStepMeta(step: ReviewStep, change: StepChange, showing?: 'accepted' | 'current'): void {
  A('div display:flex flex-wrap:wrap gap:0.4rem align-items:center font-size:0.8em color:$s-muted', () => {
    A('span #', `line ${parseLine(step.location)}`);
    A('span #', `· ${formatDuration(step.duration)}`);
    A('span #', `· ${change}`);
    if (showing) A('span #', `· showing ${showing}`);
    if (step.role) A('span font-weight:600 color:$s-accent #', `· ${step.role}`);
  });
}

function renderConsoleMessages(step: ReviewStep): void {
  const messages = step.consoleMessages ?? [];
  if (messages.length === 0) return;

  const counts: Record<ConsoleTone, number> = { error: 0, warning: 0, info: 0, debug: 0, log: 0 };
  for (const message of messages) counts[consoleTone(message.type)]++;
  const summary = (['error', 'warning', 'info', 'debug', 'log'] as ConsoleTone[])
    .filter((tone) => counts[tone] > 0)
    .map((tone) => `${counts[tone]} ${tone}`)
    .join(' · ');

  A('details', consoleStyle, () => {
    A('summary #', summary);
    A('div.list', () => {
      for (const message of messages) {
        A(`div.msg.${consoleTone(message.type)}`, () => {
          A('span.type #', String(message.type || 'log'));
          A('span #', String(message.text || ''));
          if (message.source) A('div.src #', message.source);
        });
      }
    });
  });
}

function imageSrc(kind: 'accepted' | 'current', name: string, image: string): string {
  return `/image/${kind}/${encodeURIComponent(name)}/${image}`;
}

// Status is shown as a token-coloured border on the neutral card surface.
const borderForChange: Record<StepChange, string> = {
  changed: A.insertCss('border: 2px solid $s-warning;'),
  new: A.insertCss('border: 2px solid $s-success;'),
  removed: A.insertCss('border: 2px solid $s-danger;'),
  unchanged: '',
};

function renderStep(step: ReviewStep, name: string): void {
  const change = getStepChange(step);
  S.box({
    attrs: `${borderForChange[change]} width:max-content max-width:100% mt:0`,
    contentAttrs: 'display:flex flex-direction:column align-items:stretch gap:0.5rem',
    content: () => {
      if (change === 'changed') {
        const showing = state.compareMode === 'toggle'
          ? (state.toggleShowNew ? 'current' : 'accepted')
          : state.compareMode;
        renderStepMeta(step, change, showing);
        A('div', stageStyle, '$zoom=', state.scale, () => {
          A(`img.layer${showing === 'accepted' ? '.visible' : ''} src=`, imageSrc('accepted', name, step.acceptedImage!));
          A(`img.layer${showing === 'current' ? '.visible' : ''} src=`, imageSrc('current', name, step.currentImage!));
        });
      } else {
        renderStepMeta(step, change);
        const image = step.currentImage || step.acceptedImage;
        if (image) {
          const kind = step.currentImage ? 'current' : 'accepted';
          A('div', stageStyle, '$zoom=', state.scale, () => {
            A('img src=', imageSrc(kind, name, image));
          });
        }
      }
      renderConsoleMessages(step);
    },
  });
}

function renderContent(): void {
  A(() => {
    const name = routeTestName();
    if (!name) {
      A('div display:flex height:100% align-items:center justify-content:center color:$s-muted #Select a test from the list');
      return;
    }

    if (state.loadingDetail || !state.detail) {
      A('div display:flex height:100% align-items:center justify-content:center color:$s-muted #Loading test…');
      return;
    }

    const { manifest, steps, canRevert } = state.detail;

    if (manifest) {
      A('div font-size:0.85em color:$s-muted margin-bottom:0.75rem', () => {
        A('span #', `${manifest.file} — `);
        A('span color:$s-text #', manifest.title);
      });
    }

    if (steps.length === 0) {
      A('div color:$s-muted #No screenshots taken');
    } else {
      A('div display:flex flex-wrap:wrap gap:1rem align-items:flex-start', () => {
        for (const step of steps) renderStep(step, name);
      });
    }

    if (manifest?.error) {
      A('div margin-top:1rem', () => {
        S.box({
          attrs: borderForChange.removed,
          header: () => A('span color:$s-danger #Error'),
          content: () => {
            A('div white-space:pre-wrap word-break:break-word font-family:monospace color:$s-danger #', manifest.error);
            if (manifest.errorSource) A('div color:$s-muted margin-top:0.4rem #', manifest.errorSource);
            if (manifest.errorStack) A('pre color:$s-muted font-size:0.85em overflow:auto max-height:120px #', manifest.errorStack);
          },
        });
      });
    }

    const hasChanges = selectedTestHasChanges();
    if (hasChanges || canRevert) {
      A('div display:flex gap:0.75rem flex-wrap:wrap margin-top:1rem', () => {
        if (hasChanges) {
          S.button({
            content: () => { A('#Accept visuals'); S.addTooltip({ tip: 'Accept visuals (a)' }); },
            icon: check,
            click: () => void acceptChanges(name),
          });
        }
        if (canRevert) {
          S.button({
            content: () => { A('#Revert accepted'); S.addTooltip({ tip: 'Revert accepted visuals from git (r)' }); },
            icon: undo2,
            attrs: '.nest',
            click: () => void revertChanges(name),
          });
        }
      });
    }
  });
}

function renderToolbar(): void {
  A('div display:flex align-items:center gap:1.25rem flex-wrap:wrap', () => {
    A('label display:flex align-items:center gap:0.4rem font-size:0.85em color:$s-muted', () => {
      A('span #Scale');
      A('input type=range min=0.1 max=1 step=0.01 bind=', A.ref(state, 'scale'), sliderStyle, () => {
        A({ style: `--fill:${Math.round(((state.scale - 0.1) / 0.9) * 100)}%` });
      });
      A(() => A('span color:$s-text font-variant-numeric:tabular-nums #', `${Math.round(state.scale * 100)}%`));
    });
    S.buttonChooser({
      options: {
        accepted: () => { A('#old'); S.addTooltip({ tip: 'Show accepted/old image (o)' }); },
        current: () => { A('#new'); S.addTooltip({ tip: 'Show current/new image (n)' }); },
        toggle: () => { A('#toggle'); S.addTooltip({ tip: 'Toggle between old and new (t)' }); },
      },
      bind: A.ref(state, 'compareMode'),
      attrs: '.small',
    });
  });
}

A(() => {
  S.main({
    icon: () => camera({ color: 'var(--s-primary)' }),
    title: 'ShoTest',
    subtitle: 'Screenshot review',
    nav: { items: buildNavItems() },
    navPosition: 'left',
    menu: renderToolbar,
    content: renderContent,
  });
});

void fetchTests();
