import A from 'aberdeen';
import * as route from 'aberdeen/route';
import * as S from 'staffa';
import {
  camera,
  check,
  chevronDown,
  chevronUp,
  circleAlert,
  circleCheck,
  eye,
  house,
  loaderCircle,
  trash2,
  triangleAlert,
  undo2,
} from 'staffa/icons.js';

type ConsoleTone = 'error' | 'warning' | 'info' | 'debug' | 'log';
type StepChange = 'changed' | 'unchanged' | 'removed' | 'new';
// Which side of a changed step is on show: pinned via its header buttons
// ('diff' overlays the two sides as an amplified difference), or 'auto' —
// following the global flip.
type StepSide = 'accepted' | 'current' | 'diff' | 'auto';

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

interface EventBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface StepEvent {
  type: string;
  message: string;
  box?: EventBox;
  source?: string;
  duration?: number;
  // The browser console level (log, warning, error, ...). Console events only.
  consoleType?: string;
}

interface ReviewStep {
  // Gap steps (withoutScreenshots) carry a text per side; image steps a hash
  // plus the list of events (actions, checks) recorded on that screenshot.
  acceptedGap?: string;
  currentGap?: string;
  acceptedImage?: string;
  currentImage?: string;
  acceptedEvents?: StepEvent[];
  currentEvents?: StepEvent[];
  // CSS-pixel viewport of the capture, for mapping event boxes onto the image.
  viewport?: { width: number; height: number };
  role?: string;
  changed: boolean;
}

// Whether the two sides' event lists describe the same things happening.
// Console rows are ignored: their timing shifts run to run, and offering an
// accepted/current toggle over ambient noise would put buttons on nearly
// every step. Boxes, sources and durations are display detail, not identity.
function sameSignificantEvents(accepted: StepEvent[] = [], current: StepEvent[] = []): boolean {
  const a = accepted.filter((event) => event.type !== 'console');
  const c = current.filter((event) => event.type !== 'console');
  return a.length === c.length && a.every((event, i) => event.type === c[i].type && event.message === c[i].message);
}

interface TestDetail {
  manifest: TestRecord | null;
  steps: ReviewStep[];
  canRevert: boolean;
  orphaned: boolean;
}

interface ReviewState {
  tests: TestSummary[];
  loadingTests: boolean;
  scale: number;
  toggleShowNew: boolean;
}

const state = A.proxy<ReviewState>({
  tests: [],
  loadingTests: true,
  scale: 0.8,
  toggleShowNew: true,
});

// Detail data lives per open panel (a pinned test panel keeps showing its own
// test), registered by path so the global keyboard handler can find the one
// the URL is on.
interface TestPanelCtx {
  id: string;
  $local: { detail: TestDetail | null; loading: boolean };
  reload: () => Promise<void>;
}

const testPanelCtxs = new Map<string, TestPanelCtx>();

// Always use light mode.
S.setDarkMode(false);

// Drives the automatic flip of changed steps whose side is on 'auto'.
setInterval(() => {
  state.toggleShowNew = false;
  setTimeout(() => {
    state.toggleShowNew = true;
  }, 500);
}, 1500);

// ── Scoped styles for the few custom bits Staffa doesn't cover ──────

// The screenshot stage. The `.marks` layer shares the image's grid cell, so
// an event's viewport box can be placed with percentages — correct at any
// zoom or devicePixelRatio. For changed steps two images stack in that cell
// (inside `.shots`, so a filter can hit their composite without touching the
// marks): the accepted one fully opaque below, the current one fading in and
// out above it — so mid-fade shows a true blend of the two, never the
// background (both at half opacity would darken the picture). When the images
// differ in size and the current one is on show, the larger accepted image
// would stick out around it; `.covered` hides it then, delayed past the fade
// so it is still visible while the current image is translucent.
// Pinning a step's Diff button puts the stage in `.diff`: the top image goes
// fully opaque in difference blend mode, and the stack is turned grayscale
// and brightened so hard it becomes a binary mask — unchanged pixels stay
// black, any changed pixel (even off by 1/255 on one channel) goes white.
// The `.diff .top` rules must come after `.top.visible` (equal specificity)
// to win while diffing.
const shotStyle = A.insertCss({
  '&': 'position:relative width:max-content max-width:100%',
  '.stage': 'display:inline-grid overflow:hidden border-radius:4px vertical-align:top',
  '.shots': 'grid-area:1/1 display:grid',
  '.stage img': 'grid-area:1/1 display:block max-width:none border-radius:4px',
  '.top': 'opacity:0 transition: opacity 120ms linear;',
  '.top.visible': 'opacity:1',
  '.bottom': 'transition: visibility 0s linear;',
  '.bottom.covered': 'visibility:hidden; transition: visibility 0s linear 140ms;',
  // 255² brightness: grayscale() weighs blue at only ~7%, so a 1/255 diff on
  // blue alone yields a luminance of ~0.07/255 — ×255² still clears full white.
  '.diff .shots': 'filter: grayscale(1) brightness(65025);',
  '.diff .top': 'opacity:1 transition:none mix-blend-mode:difference',
  '.marks': 'grid-area:1/1 position:relative pointer-events:none z-index:2',
  '.eventBox': 'position:absolute border: 2px solid; border-radius:4px',
});

// The shared shape of all pills: step status, step counts, role labels.
// Meaning is never carried by colour alone — every pill spells itself out.
const chipStyle = A.insertCss(
  'display:inline-flex align-items:center gap:0.3rem font-size:0.72em font-weight:700 line-height:1.5 pv:0.05rem ph:0.5rem r:99px text-transform:uppercase letter-spacing:0.04em white-space:nowrap',
);

// The step tag and its Accepted/Current side buttons form one attached pill
// group: the tag loses its right rounding, the last button gets it back. A
// pinned side is filled like a pressed control; in auto mode the side on show
// right now is merely tinted, so "showing" reads differently from "pinned".
const tagAttachedStyle = A.insertCss('border-radius: 99px 0 0 99px;');
const sideButtonStyle = A.insertCss({
  '&': 'appearance:none display:inline-flex align-items:center m:0 pv:0 ph:0.5rem font-family:inherit font-size:0.72em font-weight:600 line-height:1.5 letter-spacing:0.04em text-transform:uppercase white-space:nowrap cursor:pointer border: 1px solid $s-faint; border-left-width:0 border-radius:0 background:$s-bg color:$s-muted',
  '&:last-child': 'border-radius: 0 99px 99px 0;',
  '&.showing': 'background:$s-faint color:$s-text',
  '&.pinned': 'background:$s-primary border-color:$s-primary color:#fff',
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

A.insertGlobalCss({
  '@keyframes shotest-spin': { to: 'transform:rotate(360deg)' },
});
const spinStyle = A.insertCss('animation: shotest-spin 1s linear infinite;');

const kbdStyle = A.insertCss(
  'font-family:ui-monospace,monospace font-size:0.8em pv:0.05rem ph:0.4rem r:4px border: 1px solid $s-faint; background:$s-bg display:inline-block min-width:1.5em text-align:center',
);

// ── Data loading ────────────────────────────────────────────────────

function hrefForTest(id: string): string {
  return `/test/${encodeURIComponent(id)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((body as { error?: string } | null)?.error || `${response.status} ${response.statusText}`);
  }
  return body as T;
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
  } catch (error) {
    S.toast({ title: 'Could not load tests', message: errorMessage(error), type: 'danger' });
  } finally {
    state.loadingTests = false;
  }
}

async function acceptChanges(ctx: TestPanelCtx): Promise<void> {
  const orphaned = ctx.$local.detail?.orphaned ?? false;
  const acceptedIndex = state.tests.findIndex((test) => test.id === ctx.id);
  try {
    await fetchJson(`/api/accept/${encodeURIComponent(ctx.id)}`, { method: 'POST' });
  } catch (error) {
    S.toast({ title: orphaned ? 'Delete failed' : 'Accept failed', message: errorMessage(error), type: 'danger' });
    return;
  }
  S.toast({ message: orphaned ? 'Stale baseline deleted' : 'Visuals accepted', type: 'success', duration: 3000 });
  await fetchTests();

  // On to the next test needing review, or back to the overview when this was
  // the last one. Everything navigates by swapping the whole (single-pane)
  // stack, the same thing every link does under `linkNavigation: 'open'`.
  const next = findNextUnacceptedTestId(Math.max(0, acceptedIndex));
  void shell.openPanelStack(next ? hrefForTest(next) : '/');
}

async function revertChanges(ctx: TestPanelCtx): Promise<void> {
  ctx.$local.loading = true;
  try {
    await fetchJson(`/api/revert/${encodeURIComponent(ctx.id)}`, { method: 'POST' });
  } catch (error) {
    ctx.$local.loading = false;
    S.toast({ title: 'Revert failed', message: errorMessage(error), type: 'danger' });
    return;
  }
  S.toast({ message: 'Accepted visuals reverted to git HEAD', type: 'success', duration: 3000 });
  await fetchTests();
  await ctx.reload();
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

// ── Helpers ─────────────────────────────────────────────────────────

// The source line an event ran from, e.g. "tests/my.spec.ts:10" → "10".
function eventLine(event: StepEvent): string {
  const line = event.source?.slice(event.source.lastIndexOf(':') + 1) ?? '';
  return /^\d+$/.test(line) ? line : '';
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

function detailHasChanges(detail: TestDetail | null): boolean {
  return (detail?.steps ?? []).some((step) => getStepChange(step) !== 'unchanged');
}

function testIsFailed(status: string | undefined): boolean {
  return status === 'failed' || status === 'timedOut';
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

// The test panel the URL is currently on, if any.
function currentTestCtx(): TestPanelCtx | undefined {
  return testPanelCtxs.get(route.current.path);
}

function selectRelativeTest(offset: number): void {
  const { tests } = state;
  if (tests.length === 0) return;
  const ctx = currentTestCtx();
  const currentIndex = ctx
    ? tests.findIndex((test) => test.id === ctx.id)
    : (offset > 0 ? -1 : tests.length);
  const nextIndex = Math.min(tests.length - 1, Math.max(0, currentIndex + offset));
  if (nextIndex === currentIndex) return;
  void shell.openPanelStack(hrefForTest(tests[nextIndex].id));
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
  const ctx = currentTestCtx();

  if (key === 'a' && ctx && !ctx.$local.loading && detailHasChanges(ctx.$local.detail)) {
    event.preventDefault();
    void acceptChanges(ctx);
  } else if (key === 'r' && ctx && !ctx.$local.loading && ctx.$local.detail?.canRevert) {
    event.preventDefault();
    void revertChanges(ctx);
  }
});

// ── Status pills ────────────────────────────────────────────────────

// Statuses ride on Staffa's semantic accent surfaces, so the pills and the
// card borders below speak the same colour language: amber = changed,
// green = new, red = removed.
const statusSurface: Record<Exclude<StepChange, 'unchanged'>, string> = {
  changed: '.warning',
  new: '.success',
  removed: '.danger',
};

function drawStatusChip(change: StepChange, count?: number): void {
  if (change === 'unchanged') return;
  const label = count !== undefined ? `${count} ${change}` : change;
  A(`span.s-s${statusSurface[change]}`, chipStyle, '#', label);
}

function drawFailedChip(status: string): void {
  A('span.s-s.danger', chipStyle, '#', status === 'timedOut' ? 'timed out' : 'failed');
}

// ── Roles ───────────────────────────────────────────────────────────

// Screenshots float on a heavy drop shadow instead of sitting in a card.
// When a test uses several browser windows (roles), each role's screenshots
// throw a shadow in that role's hue, so the windows tell themselves apart.
// Equal oklch lightness and chroma keep all shadows at the same weight.
// Only hues that stay rich when darkened qualify — dark yellow/amber reads
// as brown, so the warm slot is raspberry rather than amber. Ordered for
// maximum contrast in the common two-role case.
const roleHues = [250, 350, 160, 300]; // blue, raspberry, emerald, violet
const plainShadowStyle = A.insertCss(
  'box-shadow: 0 0px 40px -6px rgba(15, 23, 42, 0.5), 0 0 15px rgba(15, 23, 42, 0.2);');
const roleShadowStyles = roleHues.map((hue) => A.insertCss(
  `box-shadow: 0 0px 40px -6px oklch(0.55 0.2 ${hue} / 0.9), 0 0 15px oklch(0.55 0.2 ${hue} / 0.5);`));

const plainChipStyle = A.insertCss('background: oklch(0.93 0.005 250); color: oklch(0.4 0.01 250);');

interface RoleInfo {
  // Colour-code only when a test actually uses several browser windows.
  multi: boolean;
  indexOf: Map<string | undefined, number>;
}

function buildRoleInfo(steps: ReviewStep[]): RoleInfo {
  const indexOf = new Map<string | undefined, number>();
  for (const step of steps) {
    if (isGapStep(step)) continue;
    if (!indexOf.has(step.role)) indexOf.set(step.role, indexOf.size);
  }
  return { multi: indexOf.size > 1, indexOf };
}

function stepShadow(roles: RoleInfo, role: string | undefined): string {
  if (!roles.multi) return plainShadowStyle;
  return roleShadowStyles[(roles.indexOf.get(role) ?? 0) % roleShadowStyles.length];
}

// The shadows tell the windows apart, but only a legend can name them.
// Renders bare swatch+name pairs; the caller's row provides layout and tone
// (it sits on the test header's file line).
function renderRoleLegend(roles: RoleInfo): void {
  if (!roles.multi) return;
  for (const [role, index] of roles.indexOf) {
    A('span display:inline-flex align-items:center gap:0.4rem', () => {
      A('span display:inline-block w:0.85em h:0.85em r:3px', `background: oklch(0.55 0.2 ${roleHues[index % roleHues.length]});`);
      A('span #', role ?? 'main');
    });
  }
}

// ── Step events ─────────────────────────────────────────────────────

// Each event type gets a hue, worn by both its chip in the event list and the
// viewport box drawn over the screenshot — so the box explains itself. Checks
// and assertions sit in the green/teal family; the action that usually ends a
// step is blue, and errors are unmistakably red. As with roles, all tints use
// equal oklch lightness/chroma so no type shouts over another.
// Console rows use their level as the chip label (log/warn/error/...), so
// those labels live in the same map; levels without an entry (log, info,
// debug) fall back to the plain gray chip.
const eventHues: Record<string, number> = {
  action: 250, // blue
  assert: 150, // green
  check: 185, // teal
  goto: 310, // violet
  wait: 70, // amber
  screenshot: 340, // pink
  warn: 45, // orange
  error: 25, // red
};

const eventChipStyles = Object.fromEntries(Object.entries(eventHues).map(([type, hue]) =>
  [type, A.insertCss(`background: oklch(0.92 0.06 ${hue}); color: oklch(0.35 0.1 ${hue});`)]));

function eventBoxCss(type: string): string {
  const hue = eventHues[type] ?? 250;
  return `border-color: oklch(0.55 0.18 ${hue}); background: oklch(0.65 0.15 ${hue} / 0.18);`;
}

const eventListStyle = A.insertCss({
  // width:0 + min-width:100%: long messages wrap instead of stretching the
  // card past its screenshot. The rows' horizontal padding is cancelled by a
  // negative margin, so their text stays aligned with the image edge above
  // while hover backgrounds still get a little air.
  '&': 'width:0 min-width:100% display:flex flex-direction:column font-size:0.8em',
  '.event': 'display:flex align-items:baseline gap:0.5rem pv:0.1rem ph:0.3rem mh:-0.3rem r:6px',
  '.event.boxed': 'cursor:pointer',
  '.event.boxed:hover': 'background:$s-faint',
  '.event.pinned': 'background:$s-faint',
  '.line': 'color:$s-muted font-size:0.85em font-variant-numeric:tabular-nums',
  '.event .msg': 'word-break:break-word',
  // A describe hint reads as a small header for the events that follow it.
  '.event.describe .msg': 'font-weight:600',
  // Browser console output: quiet for plain logs, louder with severity.
  '.event.console .msg': 'font-family:ui-monospace,monospace font-size:0.95em white-space:pre-wrap color:$s-muted',
  '.event.console.warning .msg': 'color:#b45309 font-weight:600',
  '.event.console.error .msg': 'color:$s-danger font-weight:600',
  '.src': 'margin-left:auto color:$s-muted font-size:0.85em white-space:nowrap overflow:hidden text-overflow:ellipsis max-width:40%',
  '.event .dur': 'margin-left:auto white-space:nowrap font-variant-numeric:tabular-nums font-size:0.9em font-weight:700',
});

// Per-step (card-local) UI state: which side of the step is on show (see
// StepSide), whether 'auto' follows the global flip (only steps with a real
// visual change pulse; an unchanged step offering side buttons stays calmly
// on 'current'), and whether the pointer is on the screenshot itself.
interface StepUi {
  imageHovered: boolean;
  side: StepSide;
  autoFlips: boolean;
}

// Per-event-list state: which row is hovered or has been tapped (pinned).
// Together with StepUi this decides which viewport boxes are drawn over the
// screenshot — all boxed events by default; none while the image itself is
// hovered (so it can be inspected unobstructed); only the corresponding one
// while a row is hovered or pinned.
interface ListSel {
  hovered: number;
  pinned: number;
}

// One rendered event list. A step whose sides differ in events has two —
// one per side, shown in sync with its image; every other step has a single
// one (see buildEventLists).
interface EventList {
  side?: 'accepted' | 'current';
  events: StepEvent[];
  $sel: ListSel;
}

function showingSide($ui: StepUi): 'accepted' | 'current' {
  if ($ui.side === 'accepted' || $ui.side === 'current') return $ui.side;
  // The diff overlays the current image on the accepted one; as far as the
  // stacked images are concerned, the current side is the one on show.
  if ($ui.side === 'diff') return 'current';
  return !$ui.autoFlips || state.toggleShowNew ? 'current' : 'accepted';
}

// The list whose events belong to the image side on show right now.
function activeList(lists: EventList[], $ui: StepUi): EventList {
  return (lists.length > 1 ? lists.find((list) => list.side === showingSide($ui)) : undefined) ?? lists[0];
}

function visibleMarkIndexes($ui: StepUi, $sel: ListSel, events: StepEvent[]): number[] {
  // While diffing, boxes would clutter the (mostly black) difference view.
  if ($ui.imageHovered || $ui.side === 'diff') return [];
  const isolated = $sel.hovered >= 0 ? $sel.hovered : $sel.pinned;
  if (isolated >= 0) return events[isolated]?.box ? [isolated] : [];
  return events.flatMap((event, index) => event.box ? [index] : []);
}

function renderEvents(events: StepEvent[], $sel: ListSel): void {
  if (events.length === 0) return;
  A('div', eventListStyle, () => {
    events.forEach((event, index) => {
      A('div.event', () => {
        if (event.box) {
          A('.boxed');
          A('mouseenter=', () => { $sel.hovered = index; });
          A('mouseleave=', () => { if ($sel.hovered === index) $sel.hovered = -1; });
          A('click=', () => { $sel.pinned = $sel.pinned === index ? -1 : index; });
          A(() => { if ($sel.pinned === index) A('.pinned'); });
        }
        // Console rows are chipped by their level; their source is the
        // emitting browser location, shown at the end instead of as a line
        // number in front.
        const isConsole = event.type === 'console';
        const tone = consoleTone(event.consoleType);
        const chip = isConsole ? (tone === 'warning' ? 'warn' : tone) : event.type;
        A('.' + (isConsole ? `console.${tone}` : event.type));
        if (!isConsole) {
          const line = eventLine(event);
          if (line) A('span.line #', line);
        }
        A('span', chipStyle, eventChipStyles[chip] ?? plainChipStyle, '#', chip);
        A('span.msg #', event.message);
        if (isConsole && event.source) A('span.src #', event.source);
        const duration = event.duration;
        if (typeof duration === 'number' && duration >= 300) {
          A('span.dur', `color:${duration >= 1000 ? '$s-danger' : '#d97706'}`, '#', `${Math.round(duration)}ms`);
        }
      });
    });
  });
}

// ── Rendering: nav ──────────────────────────────────────────────────

function statusIcon(test: TestSummary): () => void {
  if (test.orphaned) return () => trash2({ size: '1.1em', color: 'var(--s-danger)' });
  if (test.hasChanges) return () => circleAlert({ size: '1.1em', color: 'var(--s-warning)' });
  if (testIsFailed(test.status)) return () => triangleAlert({ size: '1.1em', color: 'var(--s-danger)' });
  return () => circleCheck({ size: '1.1em', color: 'var(--s-success)' });
}

// A file row wears the most urgent status among its tests, in the same icon
// language as the test rows — changes to review first, then failures.
// (Orphans all live in one synthetic group, so their trash icon never has to
// compete with a real file's statuses.)
function fileStatusIcon(groupTests: TestSummary[]): () => void {
  if (groupTests.some((test) => test.hasChanges)) return () => circleAlert({ size: '1.1em', color: 'var(--s-warning)' });
  if (groupTests.some((test) => test.orphaned)) return () => trash2({ size: '1.1em', color: 'var(--s-danger)' });
  if (groupTests.some((test) => testIsFailed(test.status))) return () => triangleAlert({ size: '1.1em', color: 'var(--s-danger)' });
  return () => circleCheck({ size: '1.1em', color: 'var(--s-success)' });
}

const navBadgeStyle = A.insertCss(
  'font-size:0.7em font-weight:700 line-height:1.5 pv:0 ph:0.4rem r:99px margin-left:auto flex-shrink:0',
);

function drawNavLoadingRow(): void {
  A('div display:flex align-items:center gap:0.5rem color:$s-muted pv:0.4rem ph:0.5rem font-size:0.9em', () => {
    loaderCircle({ size: '1.1em', attrs: spinStyle });
    A('span #Loading tests…');
  });
}

function buildNavItems(): S.MenuEntry[] {
  const items: S.MenuEntry[] = [
    { label: 'Overview', icon: () => house({ size: '1.1em' }), href: '/' },
  ];

  const { tests } = state;
  if (tests.length === 0) {
    items.push(state.loadingTests
      ? drawNavLoadingRow
      : () => A('div color:$s-muted font-size:0.9em pv:0.4rem ph:0.5rem #No test results found'));
    return items;
  }

  // One collapsible branch per spec file (tests are already sorted by file).
  const groups = new Map<string, TestSummary[]>();
  for (const test of tests) {
    let group = groups.get(test.file);
    if (!group) groups.set(test.file, group = []);
    group.push(test);
  }

  for (const [file, groupTests] of groups) {
    const attention = groupTests.filter((test) => test.hasChanges).length;
    items.push({
      icon: fileStatusIcon(groupTests),
      label: () => {
        A('span flex:1 min-width:0 overflow:hidden text-overflow:ellipsis white-space:nowrap #', file);
        // A folded branch must still say its tests need looking at.
        if (attention > 0) A('span.s-s.warning', chipStyle, navBadgeStyle, '#', String(attention));
      },
      items: groupTests.map((test) => ({
        // Orphans are named after their baseline entry, not a live test —
        // muted, to set them apart from the tests this run actually produced.
        label: test.orphaned ? () => A('span color:$s-muted rich=', test.title) : test.title,
        icon: statusIcon(test),
        href: hrefForTest(test.id),
      })),
    });
  }
  return items;
}

// A stable proxied array: refreshing the tests updates entries in place, so
// the sidebar redraws only what actually changed.
const $navItems = A.proxy([] as S.MenuEntry[]);
A(() => {
  A.copy($navItems, buildNavItems());
});

// ── Rendering: steps ────────────────────────────────────────────────

// Status is also a token-coloured border on the card, echoing the pill.
const warningBorder = A.insertCss('border: 2px solid $s-warning;');
const borderForChange: Record<StepChange, string> = {
  changed: warningBorder,
  new: A.insertCss('border: 2px solid $s-success;'),
  removed: A.insertCss('border: 2px solid $s-danger;'),
  unchanged: '',
};

function imageSrc(kind: 'accepted' | 'current', hash: string): string {
  return `/image/${kind}/${hash}`;
}

// The row above a screenshot: the step's status tag, plus — when the two
// sides differ in any way worth flipping between (a visual change, or event
// lists that disagree on an otherwise unchanged step) — the attached
// Accepted/Current side buttons. Steps with a real visual change get a third
// Diff button, overlaying the sides as an amplified difference. Tapping a
// button pins that state; tapping it again returns to auto.
const sideTips: Record<Exclude<StepSide, 'auto'>, string> = {
  accepted: 'Pin the accepted (old) side; tap again to return to automatic',
  current: 'Pin the current (new) side; tap again to return to automatic',
  diff: 'Highlight the changed pixels; tap again to return to automatic',
};

function renderStepHeader(change: StepChange, interactive: boolean, canDiff: boolean, $ui: StepUi): void {
  A('div display:flex align-items:stretch', () => {
    const attach = interactive ? tagAttachedStyle : '';
    if (change === 'unchanged') {
      A('span', chipStyle, plainChipStyle, attach, '#', change);
    } else {
      A(`span.s-s${statusSurface[change]}`, chipStyle, attach, '#', change);
    }
    if (!interactive) return;
    const sides = canDiff ? (['accepted', 'current', 'diff'] as const) : (['accepted', 'current'] as const);
    for (const side of sides) {
      A('button', sideButtonStyle, () => {
        A(() => {
          if ($ui.side === side) A('.pinned');
          else if ($ui.side === 'auto' && showingSide($ui) === side) A('.showing');
        });
        A('click=', () => { $ui.side = $ui.side === side ? 'auto' : side; });
        S.addTooltip({ tip: sideTips[side] });
        A('#', side);
      });
    }
  });
}

// Breathing room around a highlighted element, in viewport CSS pixels.
const markPadding = 5;

// The viewport boxes of the visible events, drawn over the image with
// percentage coordinates so they land right at any zoom level. On a
// cross-fading step the boxes come from the list of the side on show, so they
// always describe the image they are drawn on.
function renderEventMarks(step: ReviewStep, lists: EventList[], $ui: StepUi): void {
  const viewport = step.viewport;
  if (!viewport) return;
  A('div.marks', () => {
    const { events, $sel } = activeList(lists, $ui);
    for (const index of visibleMarkIndexes($ui, $sel, events)) {
      const event = events[index];
      const box = event.box!;
      const x = Math.max(0, box.x - markPadding);
      const y = Math.max(0, box.y - markPadding);
      const width = Math.min(viewport.width, box.x + box.width + markPadding) - x;
      const height = Math.min(viewport.height, box.y + box.height + markPadding) - y;
      A('div.eventBox', eventBoxCss(event.type),
        `left:${(x / viewport.width) * 100}% top:${(y / viewport.height) * 100}% ` +
        `width:${(width / viewport.width) * 100}% height:${(height / viewport.height) * 100}%`);
    }
  });
}

// The screenshot area. When the step fades between two images, both are
// stacked (see shotStyle for the layering). The imgs are created once; only
// classes toggle, so the fade actually animates.
function renderStage(step: ReviewStep, fade: boolean, lists: EventList[], $ui: StepUi, shadowStyle: string): void {
  const hash = step.currentImage || step.acceptedImage;
  if (!hash) return;
  A('div', shotStyle, () => {
    A('div.stage', shadowStyle, () => {
      // Hovering the image clears the event boxes, so it can be inspected
      // unobstructed. `.marks` is pointer-events:none and doesn't interfere.
      A('mouseenter=', () => { $ui.imageHovered = true; });
      A('mouseleave=', () => { $ui.imageHovered = false; });
      A(() => A({ $zoom: state.scale }));
      if (fade) {
        A(() => { if ($ui.side === 'diff') A('.diff'); });
        A('div.shots', () => {
          A('img.bottom src=', imageSrc('accepted', step.acceptedImage!), () => {
            // The diff needs the accepted image as its blend backdrop, so
            // never cover it while diffing.
            if ($ui.side !== 'diff' && showingSide($ui) === 'current') A('.covered');
          });
          A('img.top src=', imageSrc('current', step.currentImage!), () => {
            if (showingSide($ui) === 'current') A('.visible');
          });
        });
      } else {
        A('img src=', imageSrc(step.currentImage ? 'current' : 'accepted', hash));
      }
      renderEventMarks(step, lists, $ui);
    });
  });
}

// A subtle placeholder for steps that deliberately produced no screenshots
// (withoutScreenshots). It should read as "something routine happened here"
// without competing with the screenshots around it.
const gapStyle = A.insertCss({
  '&': 'align-self:stretch display:flex flex-direction:column align-items:center justify-content:center gap:0.4rem border: 2px dashed $s-faint; border-radius:8px pv:1rem ph:0.75rem max-width:11rem color:$s-muted scroll-margin:1rem',
  '.text': 'font-size:0.8em font-style:italic text-align:center word-break:break-word',
  '.text.was': 'text-decoration:line-through opacity:0.7',
});

// A gap carries no image, so its text is the only thing the reviewer can look
// at. An empty one (withoutScreenshots('')) would otherwise draw a blank box.
function gapText(text: string | undefined): string {
  return text ? text : '(no description)';
}

function renderGapStep(step: ReviewStep, change: StepChange, extraAttrs = ''): void {
  A('div', gapStyle, borderForChange[change], extraAttrs, () => {
    drawStatusChip(change);
    // A changed gap changed its text: showing only the new one asks the reviewer
    // to spot a difference against something they cannot see.
    if (change === 'changed' && step.acceptedGap !== undefined && step.currentGap !== undefined) {
      A('div.text.was #', gapText(step.acceptedGap));
    }
    A('div.text #', gapText(step.currentGap ?? step.acceptedGap));
  });
}

// When the sides' event lists differ, each side gets its own list, shown in
// sync with its image; otherwise a single list serves both sides — the
// current run's when it has one (it carries sources and durations), else the
// baseline's (removed/orphaned steps). Lists come with their own hover/pin
// selection.
function buildEventLists(step: ReviewStep, dual: boolean): EventList[] {
  const newSel = () => A.proxy<ListSel>({ hovered: -1, pinned: -1 });
  if (!dual) {
    const events = step.currentImage !== undefined ? step.currentEvents : step.acceptedEvents;
    return [{ events: events ?? [], $sel: newSel() }];
  }
  return [
    { side: 'accepted' as const, events: step.acceptedEvents ?? [], $sel: newSel() },
    { side: 'current' as const, events: step.currentEvents ?? [], $sel: newSel() },
  ];
}

// Both side lists render stacked in one grid cell, so the row keeps the
// height of the taller one and the layout below never jumps while flipping.
// Only the list matching the shown image is visible and interactive — and
// while diffing, no list is: the difference view describes neither side.
const listStackStyle = A.insertCss({
  '&': 'display:grid grid-template-columns:100%',
  '.list': 'grid-area:1/1 transition: opacity 120ms linear;',
  '.list.faded': 'opacity:0 pointer-events:none',
});

function renderEventLists(lists: EventList[], $ui: StepUi): void {
  A('div', listStackStyle, () => {
    for (const list of lists) {
      A('div.list', () => {
        A(() => {
          const hidden = $ui.side === 'diff'
            || (list.side !== undefined && showingSide($ui) !== list.side);
          if (hidden) A('.faded');
        });
        renderEvents(list.events, list.$sel);
      });
    }
  });
}

function renderStep(step: ReviewStep, roles: RoleInfo, extraAttrs = ''): void {
  const change = getStepChange(step);
  if (isGapStep(step)) {
    renderGapStep(step, change, extraAttrs);
    return;
  }
  // The step's changed/unchanged verdict is the server's, and purely visual —
  // events never enter into it, so this view and the sidebar always agree.
  // The sides are still flippable whenever there is anything to flip between:
  // a visual change, or event lists that disagree on an unchanged step.
  const hasBoth = step.acceptedImage !== undefined && step.currentImage !== undefined;
  const dualLists = hasBoth && !sameSignificantEvents(step.acceptedEvents, step.currentEvents);
  const interactive = hasBoth && (change === 'changed' || dualLists);
  // Cross-fade only when there really are two different images: flipping
  // between two equal frames reads as "no visible difference" — which a
  // single image says better.
  const fade = interactive && step.acceptedImage !== step.currentImage;
  const lists = buildEventLists(step, dualLists);
  const $ui = A.proxy<StepUi>({ imageHovered: false, side: 'auto', autoFlips: change === 'changed' });
  A('div display:flex flex-direction:column align-items:stretch gap:0.6rem width:max-content max-width:100% scroll-margin:1rem', extraAttrs, () => {
    renderStepHeader(change, interactive, fade, $ui);
    renderStage(step, fade, lists, $ui, stepShadow(roles, step.role));
    renderEventLists(lists, $ui);
  });
}

function renderSteps(steps: ReviewStep[], markerClass: string): void {
  if (steps.length === 0) {
    A('div color:$s-muted #No screenshots taken');
    return;
  }
  const roles = buildRoleInfo(steps);
  const firstChanged = steps.findIndex((step) => getStepChange(step) !== 'unchanged');
  // Row gap well above the image↔events gap inside a step, so an event list
  // reads as belonging to the screenshot above it, not the one below.
  A('div display:flex flex-wrap:wrap column-gap:2.5rem row-gap:3rem align-items:flex-start pt:0.5rem', () => {
    steps.forEach((step, index) => {
      // Tag the first screenshot that needs review, so the panel can scroll it
      // into view. The panel already opens at the top; only mark when the
      // first change sits somewhere below it.
      const mark = index === firstChanged && index > 0 ? `.${markerClass}` : '';
      renderStep(step, roles, mark);
    });
  });
}

// ── Rendering: test panel ───────────────────────────────────────────

// The test's action buttons, shown to the right of the test header (wrapping
// below it when the panel is narrow). Prev/next mirror Ctrl+↑/↓ for the
// mouse. They are plain links, which Staffa 0.11 made viable here: under
// `linkNavigation: 'open'` they swap the pane like any other click.
function renderTestActions(ctx: TestPanelCtx, detail: TestDetail): void {
  const index = state.tests.findIndex((test) => test.id === ctx.id);
  const prev = index > 0 ? state.tests[index - 1] : undefined;
  const next = index >= 0 ? state.tests[index + 1] : undefined;
  S.iconButton({
    icon: () => { chevronUp(); S.addTooltip({ tip: 'Previous test (Ctrl+↑)' }); },
    ariaLabel: 'Previous test',
    href: prev && hrefForTest(prev.id),
    disabled: !prev,
    attrs: '.small',
  });
  S.iconButton({
    icon: () => { chevronDown(); S.addTooltip({ tip: 'Next test (Ctrl+↓)' }); },
    ariaLabel: 'Next test',
    href: next && hrefForTest(next.id),
    disabled: !next,
    attrs: '.small',
  });
  if (detailHasChanges(detail)) {
    S.button({
      content: () => {
        A(detail.orphaned ? '#Delete baseline' : '#Accept visuals');
        S.addTooltip({ tip: detail.orphaned ? 'Delete this stale baseline (a)' : 'Accept the new visuals as the baseline (a)' });
      },
      icon: detail.orphaned ? trash2 : check,
      attrs: detail.orphaned ? '.danger.small' : '.small',
      click: () => void acceptChanges(ctx),
    });
  }
  if (detail.canRevert) {
    S.button({
      content: () => { A('#Revert'); S.addTooltip({ tip: 'Revert accepted visuals to git HEAD (r)' }); },
      icon: undo2,
      attrs: '.neutral.small',
      click: () => void revertChanges(ctx),
    });
  }
}

function renderTestHeader(ctx: TestPanelCtx, detail: TestDetail): void {
  const test = state.tests.find((entry) => entry.id === ctx.id);
  const counts = { changed: 0, new: 0, removed: 0, unchanged: 0 };
  for (const step of detail.steps) counts[getStepChange(step)]++;
  const roles = buildRoleInfo(detail.steps);

  A('div display:flex flex-wrap:wrap align-items:flex-start column-gap:1rem row-gap:0.5rem margin-bottom:1rem', () => {
    A('div display:flex flex-direction:column gap:0.3rem flex:1 min-width:min(100%,20rem)', () => {
      A('div display:flex align-items:baseline gap:0.6rem flex-wrap:wrap', () => {
        A('h2 font-size:1.15em font-weight:700 m:0 rich=', detail.manifest?.title ?? test?.title ?? 'Test');
        A('span display:inline-flex align-items:center gap:0.4rem', () => {
          if (test && !test.orphaned && testIsFailed(test.status)) drawFailedChip(test.status);
          if (counts.changed) drawStatusChip('changed', counts.changed);
          if (counts.new) drawStatusChip('new', counts.new);
          if (counts.removed) drawStatusChip('removed', counts.removed);
          if (detail.steps.length > 0 && !counts.changed && !counts.new && !counts.removed) {
            A('span font-size:0.8em color:$s-muted #', `all ${detail.steps.length} unchanged`);
          }
        });
      });
      const file = detail.manifest?.file ?? (test && !test.orphaned ? test.file : undefined);
      if (file || detail.orphaned || roles.multi) {
        A('div display:flex align-items:center flex-wrap:wrap column-gap:1.2rem row-gap:0.3rem font-size:0.85em color:$s-muted', () => {
          if (file) A('span #', test?.line ? `${file} · line ${test.line}` : file);
          else if (detail.orphaned) A('span #accepted baseline without a matching test');
          renderRoleLegend(roles);
        });
      }
    });
    // margin-left:auto keeps the buttons right-aligned, also on the row of
    // their own they wrap to when the header block needs the full width.
    A('div display:flex align-items:center gap:0.5rem margin-left:auto', () => {
      renderTestActions(ctx, detail);
    });
  });
}

function renderOrphanNotice(): void {
  A('div margin-bottom:1rem', () => {
    S.box({
      attrs: warningBorder,
      header: () => A('span color:$s-warning #Baseline without a test'),
      content: `This accepted baseline has no matching test in \`test-results/\`, so no test of that identity ran. It was most likely renamed or deleted — but a filtered run (\`-g\`, a file argument, \`--shard\`), a skipped test, or an interrupted run looks exactly the same from here. Deleting removes the baseline shown below (its images are garbage-collected if nothing else references them).`,
    });
  });
}

function renderErrorBox(manifest: TestRecord): void {
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

let panelSeq = 0;

function drawTestPanel($panel: S.Panel<{ id: string }>): void {
  $panel.maxWidth = 'screen';
  const id = $panel.params.id;
  const markerClass = `shotest-first-change-${++panelSeq}`;

  const $local = A.proxy<TestPanelCtx['$local']>({ detail: null, loading: true });
  const ctx: TestPanelCtx = {
    id,
    $local,
    reload: async () => {
      $local.loading = true;
      try {
        $local.detail = await fetchJson<TestDetail>(`/api/test/${encodeURIComponent(id)}`);
      } catch (error) {
        $local.detail = null;
        S.toast({ title: 'Could not load test', message: errorMessage(error), type: 'danger' });
      } finally {
        $local.loading = false;
      }
    },
  };
  testPanelCtxs.set($panel.path, ctx);
  A.clean(() => testPanelCtxs.delete($panel.path));
  void ctx.reload();

  A(() => { $panel.loading = $local.loading; });
  A(() => {
    const test = state.tests.find((entry) => entry.id === id);
    $panel.title = test?.title ?? 'Test';
  });

  // Once the detail is drawn and the panel is actually on screen, bring the
  // first screenshot that needs review into view. Marker classes rather than
  // element refs: Aberdeen offers no ref hook, and `create=` transitions only
  // fire for top-level redraws.
  let scrolledDetail: TestDetail | null = null;
  A(() => {
    const detail = $local.detail;
    if (!detail || $local.loading || !$panel.visible || scrolledDetail === detail) return;
    scrolledDetail = detail;
    setTimeout(() => {
      document.getElementsByClassName(markerClass)[0]
        ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 150);
  });

  A(() => {
    const { detail } = $local;
    if (!detail) {
      // While loading, the shell's own indicator covers the wait.
      if (!$local.loading) A('div color:$s-muted #Could not load this test.');
      return;
    }
    renderTestHeader(ctx, detail);
    if (detail.orphaned) renderOrphanNotice();
    renderSteps(detail.steps, markerClass);
    if (detail.manifest?.error) renderErrorBox(detail.manifest);
  });
}

// ── Rendering: overview panel ───────────────────────────────────────

function drawStatRow(icon: () => void, label: string, count: number): void {
  A('div display:flex align-items:center gap:0.6rem', () => {
    icon();
    A(count === 0 ? 'span flex:1 color:$s-muted #' : 'span flex:1 #', label);
    A('span font-weight:700 font-variant-numeric:tabular-nums #', String(count));
  });
}

function drawShortcutRow(keys: string[], label: string): void {
  A('div display:flex align-items:center gap:0.6rem', () => {
    A('span display:inline-flex gap:0.25rem flex-shrink:0 min-width:5.5rem', () => {
      for (const key of keys) A('kbd', kbdStyle, '#', key);
    });
    A('span color:$s-muted font-size:0.9em #', label);
  });
}

function drawHomePanel($panel: S.Panel<{}>): void {
  $panel.title = 'Overview';
  $panel.maxWidth = 'half';
  A(() => { $panel.loading = state.loadingTests && state.tests.length === 0; });

  A('div display:flex flex-direction:column gap:1rem align-items:stretch', () => {
    A(() => {
      const { tests } = state;
      const real = tests.filter((test) => !test.orphaned);
      const changed = real.filter((test) => test.hasChanges).length;
      const failed = real.filter((test) => testIsFailed(test.status)).length;
      const orphaned = tests.length - real.length;
      const needsReview = changed + orphaned;

      if (tests.length === 0 && !state.loadingTests) {
        S.box({
          header: 'No test results',
          content: 'Nothing found in `test-results/`. Run your Playwright tests with ShoTest, then reload this page.',
        });
        return;
      }

      S.box({
        header: 'This run',
        contentAttrs: 'display:flex flex-direction:column gap:0.5rem',
        content: () => {
          drawStatRow(() => camera({ size: '1.1em', color: 'var(--s-muted)' }), 'tests with screenshots', real.length);
          drawStatRow(() => circleAlert({ size: '1.1em', color: changed ? 'var(--s-warning)' : 'var(--s-muted)' }), 'with visual changes', changed);
          drawStatRow(() => triangleAlert({ size: '1.1em', color: failed ? 'var(--s-danger)' : 'var(--s-muted)' }), 'failed', failed);
          if (orphaned > 0) {
            drawStatRow(() => trash2({ size: '1.1em', color: 'var(--s-danger)' }), 'stale baselines', orphaned);
          }
        },
      });

      const first = findNextUnacceptedTestId(0);
      if (needsReview > 0 && first) {
        A('div', () => {
          // A real link: under `linkNavigation: 'open'` it swaps the pane like
          // every other click, and middle-click/copy-link work for free.
          S.button({
            content: `Start reviewing (${needsReview})`,
            icon: eye,
            href: hrefForTest(first),
          });
        });
      } else if (real.length > 0) {
        A('div display:flex align-items:center gap:0.5rem color:$s-success font-weight:600', () => {
          circleCheck({ size: '1.2em' });
          A('span #All screenshots match the accepted baselines.');
        });
      }
    });

    S.box({
      header: 'Keyboard shortcuts',
      contentAttrs: 'display:flex flex-direction:column gap:0.4rem',
      content: () => {
        drawShortcutRow(['a'], 'accept the new visuals');
        drawShortcutRow(['r'], 'revert accepted visuals to git HEAD');
        drawShortcutRow(['Ctrl', '↑/↓'], 'previous / next test');
        drawShortcutRow(['Esc'], 'jump to the test list');
      },
    });
  });
}

// ── Toolbar (top bar menu slot) ─────────────────────────────────────

function drawToolbar(): void {
  A(() => {
    // The scale control only means something while a test is on screen.
    if (route.current.p[0] !== 'test') return;
    A('label display:flex align-items:center gap:0.4rem font-size:0.85em color:$s-muted', () => {
      A('span #Scale');
      A('input type=range min=0.1 max=1 step=0.01 bind=', A.ref(state, 'scale'), sliderStyle, () => {
        A({ style: `--fill:${Math.round(((state.scale - 0.1) / 0.9) * 100)}%` });
      });
      A(() => A('span color:$s-text font-variant-numeric:tabular-nums #', `${Math.round(state.scale * 100)}%`));
    });
  });
}

// ── Shell ───────────────────────────────────────────────────────────

const shell = S.main({
  logo: () => camera({ color: 'var(--s-primary)', size: '1.6em' }),
  title: 'ShoTest',
  subtitle: 'Playwright + visual diffs',
  nav: { items: $navItems },
  navPosition: 'left',
  // The conventional sidebar-and-content model (new in Staffa 0.11): one pane,
  // swapped on every click — nav items, in-panel links and the prev/next
  // actions all replace the content as a whole.
  columns: 'single',
  linkNavigation: 'open',
  menu: drawToolbar,
  routes: {
    '/': drawHomePanel,
    '/test/[id]': drawTestPanel,
  },
  notFound: ($panel) => {
    $panel.title = 'Not found';
    S.box({
      header: 'Not found',
      content: () => {
        A('p m:0 #', `No such page: ${$panel.path}`);
        A('p mb:0 rich=Head back to the [overview](/).');
      },
    });
  },
})!;

void fetchTests();
