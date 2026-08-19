import A from 'aberdeen';
import * as route from 'aberdeen/route';
import * as S from 'staffa';
import {
  camera,
  check,
  circleAlert,
  circleCheck,
  trash2,
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
  id: string;
  file: string;
  line: number;
  title: string;
  status: string;
  hasChanges: boolean;
  // An accepted baseline with no matching test in test-results.
  orphaned: boolean;
}

interface TestRecord {
  file: string;
  title: string;
  error?: string;
  errorSource?: string;
  errorStack?: string;
}

interface ReviewStep {
  // Gap steps (withoutScreenshots) carry a text per side; image steps a hash.
  acceptedGap?: string;
  currentGap?: string;
  acceptedImage?: string;
  currentImage?: string;
  location?: string;
  name?: string;
  description?: string;
  duration?: number;
  role?: string;
  consoleMessages?: ConsoleMessageInfo[];
  changed: boolean;
}

interface TestDetail {
  manifest: TestRecord | null;
  steps: ReviewStep[];
  canRevert: boolean;
  orphaned: boolean;
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
  // width:0 + min-width:100%: contributes nothing to the card's max-content
  // width (so a long console line can't stretch the card past its screenshot)
  // while still filling the card during layout.
  '&': 'width:0 min-width:100% font-size:0.8em',
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

function routeTestId(): string | null {
  return route.current.p[0] === 'test' && route.current.p[1]
    ? decodeURIComponent(route.current.p[1])
    : null;
}

function hrefForTest(id: string): string {
  return `/test/${encodeURIComponent(id)}`;
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
      // Orphaned baselines have no source file to sort by; they go last.
      Number(a.orphaned) - Number(b.orphaned)
      || a.file.localeCompare(b.file)
      || a.line - b.line
      || a.title.localeCompare(b.title),
    );
    // Update in place (instead of replacing the array) so only tests that
    // actually changed redraw — keeping the nav pane's DOM and scroll intact.
    A.copy(state, 'tests', tests);
  } finally {
    state.loadingTests = false;
  }
}

async function loadDetail(id: string): Promise<void> {
  state.detail = null;
  state.loadingDetail = true;
  const token = ++detailToken;
  try {
    const detail = await fetchJson<TestDetail>(`/api/test/${encodeURIComponent(id)}`);
    if (token === detailToken) {
      state.detail = detail;
    }
  } finally {
    if (token === detailToken) {
      state.loadingDetail = false;
    }
  }
}

async function acceptChanges(id: string): Promise<void> {
  const acceptedIndex = state.tests.findIndex((test) => test.id === id);
  await fetch(`/api/accept/${encodeURIComponent(id)}`, { method: 'POST' });
  await fetchTests();

  const next = findNextUnacceptedTestId(Math.max(0, acceptedIndex));
  route.go(next ? hrefForTest(next) : '/');
}

async function revertChanges(id: string): Promise<void> {
  state.detail = null;
  state.loadingDetail = true;
  await fetch(`/api/revert/${encodeURIComponent(id)}`, { method: 'POST' });
  await fetchTests();
  await loadDetail(id);
}

function findNextUnacceptedTestId(startIndex: number): string | null {
  const { tests } = state;
  for (let i = startIndex; i < tests.length; i += 1) {
    if (tests[i].hasChanges) return tests[i].id;
  }
  for (let i = 0; i < Math.min(startIndex, tests.length); i += 1) {
    if (tests[i].hasChanges) return tests[i].id;
  }
  return null;
}

// React to URL changes: (re)load the selected test's detail.
A(() => {
  const id = routeTestId();
  // The shell isn't rebuilt on navigation, so reset the content scroll ourselves.
  document.querySelector('.s-main main')?.scrollTo(0, 0);
  if (id) {
    void loadDetail(id);
  } else {
    detailToken++;
    state.detail = null;
    state.loadingDetail = false;
  }
});

// ── Helpers ─────────────────────────────────────────────────────────

function parseLine(location?: string): string {
  if (!location) return '?';
  const index = location.lastIndexOf(':');
  return index >= 0 ? location.slice(index + 1) : '?';
}

function isGapStep(step: ReviewStep): boolean {
  return step.acceptedGap !== undefined || step.currentGap !== undefined;
}

function getStepChange(step: ReviewStep): StepChange {
  const hasAccepted = step.acceptedImage !== undefined || step.acceptedGap !== undefined;
  const hasCurrent = step.currentImage !== undefined || step.currentGap !== undefined;
  if (!hasAccepted) return 'new';
  if (!hasCurrent) return 'removed';
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
  const selected = routeTestId();
  const currentIndex = selected
    ? tests.findIndex((test) => test.id === selected)
    : (offset > 0 ? -1 : tests.length);
  const nextIndex = Math.min(tests.length - 1, Math.max(0, currentIndex + offset));
  if (nextIndex !== currentIndex) {
    route.go(hrefForTest(tests[nextIndex].id));
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
  const selected = routeTestId();

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
  if (test.orphaned) return () => trash2({ size: '1.1em', color: 'var(--s-danger)' });
  if (test.hasChanges) return () => circleAlert({ size: '1.1em', color: 'var(--s-warning)' });
  if (failed) return () => triangleAlert({ size: '1.1em', color: 'var(--s-danger)' });
  return () => circleCheck({ size: '1.1em', color: 'var(--s-success)' });
}

// The whole test list is a single stable nav slot rendered with A.onEach, so a
// tests refresh (e.g. after accepting) updates items in place instead of
// rebuilding the sidebar — which would reset its scroll position.
function drawNavEntries(): void {
  A.onEach(state.tests, (test, index) => {
    A(() => {
      if (test.file !== (index > 0 ? state.tests[index - 1]?.file : undefined)) {
        A('div font-size:0.8em font-weight:600 color:$s-muted mt:0.5rem mb:0.1rem #', test.file);
      }
    });
    const href = hrefForTest(test.id);
    A('a.s-menu-item href=', href, () => {
      A(() => { if (route.matchCurrent(href)) A('aria-current=page'); });
      A('span.s-menu-icon', () => statusIcon(test)());
      // Orphans are named after their baseline entry, not a live test — muted,
      // to set them apart from the tests this run actually produced.
      A(test.orphaned ? 'span color:$s-muted rich=' : 'span rich=', test.title);
    });
  });
}

// The header above a screenshot: the test author's one-line description (from
// page.describe), then the muted step facts. Duration moved to the footer.
function renderStepMeta(step: ReviewStep, change: StepChange, showing?: 'accepted' | 'current'): void {
  A('div display:flex flex-direction:column gap:0.15rem max-width:100%', () => {
    if (step.description) A('div font-size:0.85em font-weight:600 #', step.description);
    A('div display:flex flex-wrap:wrap gap:0.4rem align-items:center font-size:0.8em color:$s-muted', () => {
      // Source line comes from the test run; a baseline-only (orphaned/removed)
      // step can only be named by its label or image.
      const label = step.location ? `line ${parseLine(step.location)}` : (step.name || step.acceptedImage || 'baseline');
      A('span #', step.name && step.location ? `${step.name} · ${label}` : label);
      A('span #', `· ${change}`);
      if (showing) A('span #', `· showing ${showing}`);
      if (step.role) A('span font-weight:600 color:$s-accent #', `· ${step.role}`);
    });
  });
}

// Below the screenshot: only what deserves attention — a slow step and the
// console messages it produced.
function renderStepFooter(step: ReviewStep): void {
  const duration = step.duration;
  if (typeof duration === 'number' && duration >= 300) {
    const color = duration >= 1000 ? '$s-danger' : '#d97706';
    A(`div font-size:0.8em font-weight:700 color:${color} #`, `${Math.round(duration)}ms`);
  }
  renderConsoleMessages(step);
}

function renderConsoleMessages(step: ReviewStep): void {
  const messages = step.consoleMessages ?? [];
  if (messages.length === 0) return;

  const counts: Record<ConsoleTone, number> = { error: 0, warning: 0, info: 0, debug: 0, log: 0 };
  for (const message of messages) counts[consoleTone(message.type)]++;
  const tones = (['error', 'warning', 'info', 'debug', 'log'] as ConsoleTone[]).filter((tone) => counts[tone] > 0);

  A('details', consoleStyle, () => {
    A('summary', () => {
      tones.forEach((tone, index) => {
        const text = `${index > 0 ? ' · ' : ''}${counts[tone]} ${tone}`;
        // Error counts must stand out.
        if (tone === 'error') A('span font-weight:700 color:$s-danger #', text);
        else A('span #', text);
      });
    });
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

function imageSrc(kind: 'accepted' | 'current', hash: string): string {
  return `/image/${kind}/${hash}`;
}

// Each browser window (role) gets its own subtle surface tint, so it's obvious
// at a glance which window a screenshot came from. The first role keeps the
// default surface; the others override the box's `--s-bg` (the derived tokens —
// border, muted ink, gradient — follow automatically). Equal oklch lightness
// and chroma keep all tints at the same visual weight. We're always in light
// mode, so hard-coded light values are fine.
const roleTints = [
  '',
  A.insertCss({ '&.s-s.neutral': '--s-bg: oklch(0.97 0.025 250);' }), // blue
  A.insertCss({ '&.s-s.neutral': '--s-bg: oklch(0.97 0.025 80);' }), // amber
  A.insertCss({ '&.s-s.neutral': '--s-bg: oklch(0.97 0.025 320);' }), // violet
];

function buildRoleTintMap(steps: ReviewStep[]): Map<string | undefined, string> {
  const tints = new Map<string | undefined, string>();
  for (const step of steps) {
    if (isGapStep(step)) continue;
    if (!tints.has(step.role)) tints.set(step.role, roleTints[tints.size % roleTints.length]);
  }
  return tints;
}

// Also marks the orphaned-baseline notice. A surface class (`.warning`) can't do
// that job: `.neutral` from S.box wins over it.
const warningBorder = A.insertCss('border: 2px solid $s-warning;');

// Status is shown as a token-coloured border on the neutral card surface.
const borderForChange: Record<StepChange, string> = {
  changed: warningBorder,
  new: A.insertCss('border: 2px solid $s-success;'),
  removed: A.insertCss('border: 2px solid $s-danger;'),
  unchanged: '',
};

// A subtle placeholder for steps that deliberately produced no screenshots
// (withoutScreenshots). It should read as "something routine happened here"
// without competing with the screenshots around it.
const gapStyle = A.insertCss({
  '&': 'align-self:stretch display:flex flex-direction:column align-items:center justify-content:center gap:0.4rem border: 2px dashed $s-faint; border-radius:8px pv:1rem ph:0.75rem max-width:11rem color:$s-muted',
  '.text': 'font-size:0.8em font-style:italic text-align:center word-break:break-word',
  '.status': 'font-size:0.75em',
});

function renderGapStep(step: ReviewStep, change: StepChange): void {
  A('div', gapStyle, change === 'unchanged' ? '' : borderForChange[change], () => {
    A('div.text #', step.currentGap ?? step.acceptedGap ?? '');
    if (change !== 'unchanged') A('div.status #', change);
  });
}

function renderStep(step: ReviewStep, tint: string): void {
  const change = getStepChange(step);
  if (isGapStep(step)) {
    renderGapStep(step, change);
    return;
  }
  S.box({
    attrs: `${borderForChange[change]} ${tint} width:max-content max-width:100% mt:0`,
    contentAttrs: 'display:flex flex-direction:column align-items:stretch gap:0.5rem',
    content: () => {
      if (change === 'changed') {
        const showing = state.compareMode === 'toggle'
          ? (state.toggleShowNew ? 'current' : 'accepted')
          : state.compareMode;
        renderStepMeta(step, change, showing);
        A('div', stageStyle, '$zoom=', state.scale, () => {
          A(`img.layer${showing === 'accepted' ? '.visible' : ''} src=`, imageSrc('accepted', step.acceptedImage!));
          A(`img.layer${showing === 'current' ? '.visible' : ''} src=`, imageSrc('current', step.currentImage!));
        });
      } else {
        renderStepMeta(step, change);
        const hash = step.currentImage || step.acceptedImage;
        if (hash) {
          const kind = step.currentImage ? 'current' : 'accepted';
          A('div', stageStyle, '$zoom=', state.scale, () => {
            A('img src=', imageSrc(kind, hash));
          });
        }
      }
      renderStepFooter(step);
    },
  });
}

function renderContent(): void {
  A(() => {
    const id = routeTestId();
    if (!id) {
      A('div display:flex height:100% align-items:center justify-content:center color:$s-muted #Select a test from the list');
      return;
    }

    if (state.loadingDetail || !state.detail) {
      A('div display:flex height:100% align-items:center justify-content:center color:$s-muted #Loading test…');
      return;
    }

    const { manifest, steps, canRevert, orphaned } = state.detail;

    if (manifest) {
      A('div font-size:0.85em color:$s-muted margin-bottom:0.75rem', () => {
        A('span #', `${manifest.file} — `);
        A('span color:$s-text #', manifest.title);
      });
    }

    if (orphaned) {
      A('div margin-bottom:1rem', () => {
        S.box({
          attrs: warningBorder,
          header: () => A('span color:$s-warning #Baseline without a test'),
          content: `This accepted baseline has no matching test in \`test-results/\`, so no test of that identity ran. It was most likely renamed or deleted — but a filtered run (\`-g\`, a file argument, \`--shard\`), a skipped test, or an interrupted run looks exactly the same from here. Accepting deletes the baseline shown below (its images are garbage-collected if nothing else references them).`,
        });
      });
    }

    if (steps.length === 0) {
      A('div color:$s-muted #No screenshots taken');
    } else {
      const roleTintMap = buildRoleTintMap(steps);
      A('div display:flex flex-wrap:wrap gap:1rem align-items:flex-start', () => {
        for (const step of steps) renderStep(step, roleTintMap.get(step.role) ?? '');
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
            content: () => {
              A(orphaned ? '#Delete baseline' : '#Accept visuals');
              S.addTooltip({ tip: orphaned ? 'Delete this stale baseline (a)' : 'Accept visuals (a)' });
            },
            icon: orphaned ? trash2 : check,
            attrs: orphaned ? '.danger' : undefined,
            click: () => void acceptChanges(id),
          });
        }
        if (canRevert) {
          S.button({
            content: () => { A('#Revert accepted'); S.addTooltip({ tip: 'Revert accepted visuals from git (r)' }); },
            icon: undo2,
            attrs: '.nest',
            click: () => void revertChanges(id),
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
    nav: { items: [drawNavEntries] },
    navPosition: 'left',
    menu: renderToolbar,
    content: renderContent,
  });
});

void fetchTests();
