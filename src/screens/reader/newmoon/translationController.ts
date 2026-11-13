import { sharedChapterBudget } from '@services/translation/chapterBudget';
// src/screens/reader/newmoon/translationController.ts
//
// RN-side controller for the reader translation feature (Zeus Ascent port).
// Sits between the New-moon-2 shell (WebView) and the translation engine in
// src/services/translation:
//
//   • shell → RN : handleShellEvent({t:'trDetect'|'trCollect'|'trButton'|…})
//   • RN → shell : the `post` callback injected via setBridge — the screen
//     wires it to bridgeRef.current.post so every command is buffered until
//     the shell fires `ready` (NewMoonBridge queue semantics).
//
// The controller NEVER touches the WebView (no reload, no injectJavaScript of
// its own): the document is frozen and the shell owns all DOM state. This file
// is pure bookkeeping plus the Zeus coordinator/memory/prefs services.
//
// Memory namespace contract (must match ReaderTranslationCoordinator):
//   pageID      = `reader:{novelId}:{chapterId}#{wNum}`
//   namespace[] = memoryIdentity(pageID, prefs, effectiveProvider)
// The `#{wNum}` suffix and the glossary/customInstruction-aware effective
// provider are what make prefetch entries hit for both navigation paths
// (direct chapter load and continuous-mode append).

import { InteractionManager } from 'react-native';

import {
  ReaderTranslationCoordinator,
  TranslationMemory,
  autoEnabled,
  createSqliteMemoryDriver,
  detectLanguage,
  isAIEngine,
  isRTLLanguage,
  keepsTranslations,
  loadPreferences,
  loadProviders,
  memoryIdentity,
  primarySubtag,
  providerById,
  readSecret,
  savePreferences,
  translateSegments,
  AI_COLLECT_CAPS,
  type AIProviderConfiguration,
  type CollectedSegment,
  type CoordinatorApplyItem,
  type CoordinatorProgress,
  type TranslationPreferences,
} from '@services/translation';

/** Shell → RN translation event (subset of parseShellEvent's output). */
export type TranslationShellEvent = { t: string } & Record<string, unknown>;

/** RN → shell translation commands. Type aliases (not interfaces) keep the
 *  union structurally assignable to the bridge's ShellCommand record type. */
type TrCommand =
  | {
      kind: 'trConfig';
      enabled: boolean;
      target: string;
      rtl: boolean;
      caps?: { maxCharacters: number; maxSegments: number };
    }
  | {
      kind: 'trStart';
      target: string;
      caps?: { maxCharacters: number; maxSegments: number };
    }
  | { kind: 'trCollect' }
  | { kind: 'trApply'; items: CoordinatorApplyItem[]; expected: number }
  | { kind: 'trRestore' }
  | {
      kind: 'trProgress';
      status: CoordinatorProgress['status'];
      completed: number;
      total: number;
      reused: number;
      error: string | null;
      requests: number;
    }
  | { kind: 'trOffer'; visible: boolean };

export type TrPost = (msg: TrCommand) => void;

/** Route name handed to the screen's navigate callback. */
export type TrNavigate = (route: string) => void;

/** One background-prefetched chapter (plain wor blocks from the screen). */
export interface PrefetchChapterContext {
  // Database PKs are numbers in this app; accept both and normalize to string
  // (memory/namespace identity is string-based, mirroring Zeus's string keys).
  novelId: string | number;
  chapterId: string | number;
  /** Reader-order position the chapter occupies in the document. */
  wNum: number;
  /** Plain wor text blocks (paragraph-level, `\n`-split). */
  lines: string[];
}

const PREFETCH_MAX_CHAPTERS = 2;
const PREFETCH_HIT_RATIO = 0.8;
/** Cooldown after interactions settle — prefetch must never compete with the
 *  apply/render burst or an in-flight chapter fetch. */
const PREFETCH_IDLE_DELAY_MS = 2500;
/** Bound for the wNum → chapterId section map (primary + continuous appends). */
const SECTION_MAP_LIMIT = 16;

/** A block that contains nothing but (optional) `<img …>` lines. */
const isImageOnlyBlock = (block: string): boolean =>
  block
    .split('\n')
    .every(line => line.trim().length === 0 || line.trim().startsWith('<img'));

export class TranslationController {
  private prefs: TranslationPreferences;
  private providers: ReturnType<typeof loadProviders>;
  private readonly memory: TranslationMemory;
  private memoryInit: Promise<void> | null = null;
  private coordinator: ReaderTranslationCoordinator;

  private postMessage: TrPost | null = null;
  private navigate: TrNavigate | null = null;
  private onCompleted: (() => void) | null = null;
  private disposed = false;
  private readonly budget = sharedChapterBudget;
  private prefetchCoordinator: ReaderTranslationCoordinator | null = null;
  private startPending = false;
  private startToken = 0;

  /** Primary document scope (novel + the chapter that owns the document). */
  private scope: { novelId: string; chapterId: string } = {
    novelId: '',
    chapterId: '',
  };
  /** wor section number → chapter id (primary + continuous appends) so the
   *  memory namespace stays `reader:{novel}:{owningChapterId}#{section}`. */
  private readonly sectionIds = new Map<number, string>();
  /** Shell said `more` for a chapter — ask for the next chunk after an apply. */
  private readonly moreRef = new Map<number, boolean>();
  private offerShown = false;
  private pendingRestore = false;
  private lastStatus: CoordinatorProgress['status'] = 'idle';
  /** Output identity at the last start() — a change resets the memory session
   *  cache so stale-namespace hits can never leak across engine/target swaps. */
  private lastStartSig: string | null = null;

  // Prefetch state: chained (never two in parallel), deduped per scope.
  private prefetchChain: Promise<void> = Promise.resolve();
  private readonly prefetchDone = new Set<string>();

  constructor() {
    this.prefs = loadPreferences();
    this.providers = loadProviders();
    this.memory = new TranslationMemory(createSqliteMemoryDriver());
    this.coordinator = this.buildCoordinator();
  }

  // --------------------------------------------------------------- setup ---

  setBridge(post: TrPost): void {
    this.postMessage = post;
  }

  setNavigation(navigate: TrNavigate): void {
    this.navigate = navigate;
  }

  setOnCompleted(fn: (() => void) | null): void {
    this.onCompleted = fn;
  }

  /** Live preferences (the screen reads these for prefetch decisions). */
  get preferences(): TranslationPreferences {
    return this.prefs;
  }

  /** Unmount — drop callbacks so in-flight work becomes a no-op. */
  dispose(): void {
    this.disposed = true;
    this.startToken++;
    this.coordinator.restore();
    this.prefetchCoordinator?.restore();
    this.postMessage = null;
    this.navigate = null;
    this.onCompleted = null;
  }

  // -------------------------------------------------- shell event routing ---

  handleShellEvent(msg: TranslationShellEvent): void {
    switch (msg.t) {
      case 'trDetect':
        this.handleDetect(msg.lang, msg.sample);
        break;
      case 'trCollect':
        this.handleCollect(msg);
        break;
      case 'trApplied':
        // Shell ack for a trApply batch — progress truth lives RN-side.
        break;
      case 'trRestored':
        this.handleRestored();
        break;
      case 'trButton':
        this.handleButton(String(msg.action ?? ''));
        break;
      case 'trSettings':
        this.openSettings();
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------ screen surface ---

  /** Current trConfig — re-sent on ready/every chapter so the shell can
   *  update its translate button + RTL layout without a document reload.
   *  v3: engine-aware collect caps — AI rounds carry the whole chapter so
   *  the coordinator's batch policy decides the real request split. */
  configForChapter(): void {
    const caps = isAIEngine(this.prefs)
      ? {
          maxCharacters: AI_COLLECT_CAPS.maxCharacters,
          maxSegments: AI_COLLECT_CAPS.maxSegments,
        }
      : undefined;
    this.post({
      kind: 'trConfig',
      enabled: true,
      target: this.prefs.target,
      rtl: isRTLLanguage(this.prefs.target),
      caps,
    });
  }

  /** New primary chapter (or a fresh document after recovery): reset the
   *  translation UI state. Queued/applied coordinator work is kept because
   *  continuous mode keeps previous sections visible in the same document. */
  onChapterChanged(): void {
    this.offerShown = false;
    this.pendingRestore = false;
    this.moreRef.clear();
    this.configForChapter();
  }

  setChapterScope(
    novelId: string | number,
    chapterId: string | number,
    wNum: number,
  ): void {
    if (
      this.scope.chapterId !== String(chapterId) ||
      this.scope.novelId !== String(novelId)
    ) {
      this.coordinator.restore();
    }
    this.startToken++;
    this.startPending = false;
    this.scope = { novelId: String(novelId), chapterId: String(chapterId) };
    this.rememberSection(wNum, String(chapterId));
    this.prefetchDone.clear(); // new position → new neighbor window
  }

  /** Continuous mode appended a section — its own chapter id joins the
   *  namespace map so cached translations key per real chapter. */
  associateChapter(wNum: number, chapterId: string | number): void {
    this.rememberSection(wNum, String(chapterId));
  }

  /** Persist new preferences; swap the coordinator when the translation
   *  output identity changed (engine/target/provider/instruction/glossary). */
  updatePrefs(next: TranslationPreferences): void {
    const before = this.outputSignature();
    savePreferences(next);
    this.prefs = next;
    // Providers may have been edited in the settings screen too — MMKV is
    // the single source of truth and reading it is cheap.
    this.providers = loadProviders();
    if (before !== this.outputSignature()) {
      // Namespace identity changed: drop the session (queued work + memory
      // session cache) and rebuild so the coordinator's prefs snapshot and
      // provider list match what translateSegments will read.
      this.coordinator.invalidateSession();
      this.coordinator = this.buildCoordinator();
      this.lastStartSig = null;
    }
    this.configForChapter();
  }

  /** Re-read stored preferences (screen focus after the settings screen) —
   *  keeps the reader live without any WebView reload. */
  refreshPrefs(): void {
    this.updatePrefs(loadPreferences());
  }

  /** Begin a translation run for the current scope (shell starts collecting). */
  start(): void {
    if (this.coordinator.status === 'running' || this.startPending) {
      return;
    }
    // A non-idle session (completed/error/paused — e.g. after a document
    // reload or chapter navigation) must not shadow re-collected segment
    // ids: restore() clears the dedupe set so the fresh run re-applies.
    if (this.coordinator.status !== 'idle') {
      this.coordinator.restore();
    }
    const sig = this.outputSignature();
    if (sig !== this.lastStartSig) {
      this.memory.resetSession();
      this.lastStartSig = sig;
    }
    this.coordinator.setScope({
      novelId: this.scope.novelId,
      chapterId: this.scope.chapterId,
    });
    const scope = this.scope;
    const token = ++this.startToken;
    const postStart = () => {
      if (token !== this.startToken) return;
      this.startPending = false;
      if (!this.disposed && scope === this.scope) {
        this.post({
          kind: 'trStart',
          target: this.prefs.target,
          caps: isAIEngine(this.prefs)
            ? {
                maxCharacters: AI_COLLECT_CAPS.maxCharacters,
                maxSegments: AI_COLLECT_CAPS.maxSegments,
              }
            : undefined,
        });
      }
    };
    if (this.prefetchCoordinator?.status === 'running') {
      this.startPending = true;
      void this.prefetchChain.then(postStart);
    } else {
      postStart();
    }
  }

  /** Queue one chapter for background pre-translation. Serialized internally
   *  (never two prefetches in parallel), deduped, capped at 2 chapters per
   *  scope, and skipped entirely when retention is off or already ≥80% hot. */
  prefetchNext(ctx: PrefetchChapterContext): void {
    if (this.disposed) {
      return;
    }
    if (
      Math.min(
        PREFETCH_MAX_CHAPTERS,
        Math.max(0, this.prefs.prefetchNextChapters),
      ) <= 0
    ) {
      return;
    }
    if (!keepsTranslations(this.prefs)) {
      // Retention off → nothing would be stored, prefetch is pointless.
      return;
    }
    if (this.prefetchDone.size >= PREFETCH_MAX_CHAPTERS) {
      return;
    }
    const ctxKey = String(ctx.chapterId);
    if (this.prefetchDone.has(ctxKey)) {
      return;
    }
    // Reserved up-front: a failed prefetch is not retried within this scope
    // (prevents retry storms; the scope reset on chapter change re-arms it).
    this.prefetchDone.add(ctxKey);
    this.prefetchChain = this.prefetchChain
      .then(() => this.runPrefetch(ctx))
      .catch(() => {
        // Prefetch is strictly best-effort — failures surface nowhere.
      });
  }

  // ------------------------------------------------------------- internals ---

  private buildCoordinator(): ReaderTranslationCoordinator {
    return new ReaderTranslationCoordinator(this.prefs, this.providers, {
      memory: this.memory,
      budget: this.budget,
      translate: translateSegments,
      getSecret: key => readSecret(key),
      onApply: items => this.handleApply(items),
      onProgress: progress => this.handleProgress(progress),
      // Zeus Task.yield equivalent — batches never starve the UI thread.
      yieldSlice: () =>
        new Promise<void>(resolve => {
          InteractionManager.runAfterInteractions(() => resolve());
        }),
    });
  }

  private post(msg: TrCommand): void {
    if (!this.disposed) {
      this.postMessage?.(msg);
    }
  }

  private ensureMemory(): Promise<void> {
    if (this.memoryInit === null) {
      this.memoryInit = this.memory.initialize().catch(() => {
        // Schema already present / transient open failure — lookups will
        // simply miss; never block translation on storage errors.
      });
    }
    return this.memoryInit;
  }

  /** Full identity of everything that changes translation output — superset
   *  of the Zeus session signature (engine + target + providerID + model). */
  private outputSignature(): string {
    const provider = providerById(this.providers, this.prefs.providerID);
    return [
      this.prefs.engine,
      this.prefs.target,
      this.prefs.providerID ?? '',
      provider?.model ?? '',
      provider?.baseURL ?? '',
      provider?.instruction ?? '',
      this.prefs.customInstruction,
      keepsTranslations(this.prefs) ? 'keep' : 'drop',
      JSON.stringify(this.prefs.glossary),
      String(this.prefs.aiMaxRequestsPerChapter),
      String(this.prefs.aiDailyRequestLimit),
      String(this.prefs.aiStreaming),
    ].join('|');
  }

  // Parity with ReaderTranslationCoordinator.effectiveProvider (private
  // there): glossary + custom style ride on the AI instruction, and the
  // namespace identity must match byte-for-byte for prefetch hits.
  private effectiveProvider(): AIProviderConfiguration | null {
    const provider = providerById(this.providers, this.prefs.providerID);
    if (!provider || this.prefs.engine !== 'ai') {
      return provider;
    }
    const glossaryText =
      this.prefs.glossary.length > 0
        ? `Maintain this glossary strictly: ${this.prefs.glossary
            .slice(0, 200)
            .map(entry => `${entry.term} => ${entry.replacement}`)
            .join('; ')}`
        : '';
    const instruction = [
      provider.instruction,
      this.prefs.customInstruction,
      glossaryText,
    ]
      .filter(value => value && value.length > 0)
      .join('\n');
    return { ...provider, instruction };
  }

  private rememberSection(wNum: number, chapterId: string): void {
    this.sectionIds.set(wNum, chapterId);
    if (this.sectionIds.size > SECTION_MAP_LIMIT) {
      const oldest = this.sectionIds.keys().next();
      if (oldest.done !== true) {
        this.sectionIds.delete(oldest.value);
      }
    }
  }

  // ------------------------------------------------------------ handlers ---

  private handleDetect(lang: unknown, sample: unknown): void {
    const hint = typeof lang === 'string' ? lang : undefined;
    const text = typeof sample === 'string' ? sample : '';
    if (text.trim().length === 0) {
      return;
    }
    const detected = detectLanguage(text, hint);
    const targetPrimary = primarySubtag(this.prefs.target);
    if (detected.length === 0 || detected === targetPrimary) {
      return;
    }
    if (autoEnabled('reader', this.prefs)) {
      this.start();
      return;
    }
    if (
      this.prefs.suggest &&
      !this.offerShown &&
      this.coordinator.status === 'idle'
    ) {
      // Offer once per chapter (offerShown resets in onChapterChanged).
      this.offerShown = true;
      this.post({ kind: 'trOffer', visible: true });
    }
  }

  private handleCollect(msg: TranslationShellEvent): void {
    const chapter = Number(msg.chapter);
    if (!Number.isFinite(chapter) || chapter <= 0) {
      return;
    }
    const raw: unknown[] = Array.isArray(msg.segments) ? msg.segments : [];
    const batchTier = typeof msg.tier === 'number' ? msg.tier : 0;
    const segments: CollectedSegment[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const id = record.id;
      const text = record.text;
      if (typeof id !== 'string' || typeof text !== 'string') {
        continue;
      }
      const tier = typeof record.tier === 'number' ? record.tier : batchTier;
      segments.push({ id, text, tier, distance: 0, chapter });
    }
    if (msg.more === true) {
      this.moreRef.set(chapter, true);
    } else {
      this.moreRef.delete(chapter);
    }
    if (segments.length === 0) {
      return;
    }
    const scope = {
      novelId: this.scope.novelId,
      chapterId: this.sectionIds.get(chapter) ?? this.scope.chapterId,
    };
    void this.ensureMemory().then(() => {
      this.coordinator.addSegments(segments, scope);
    });
  }

  private handleApply(items: CoordinatorApplyItem[]): void {
    if (items.length === 0) {
      return;
    }
    // Batches can span sections in continuous mode — the shell applies per
    // chapter, so split before posting (expected = the chapter number).
    const byChapter = new Map<number, CoordinatorApplyItem[]>();
    for (const item of items) {
      const group = byChapter.get(item.chapter);
      if (group) {
        group.push(item);
      } else {
        byChapter.set(item.chapter, [item]);
      }
    }
    for (const [chapter, group] of byChapter) {
      this.post({ kind: 'trApply', items: group, expected: chapter });
      if (this.moreRef.get(chapter) === true) {
        // Chunked collection: the shell waits for this ack before slicing
        // the next batch of segments.
        this.moreRef.delete(chapter);
        this.post({ kind: 'trCollect' });
      }
    }
  }

  private handleProgress(progress: CoordinatorProgress): void {
    this.post({
      kind: 'trProgress',
      status: progress.status,
      completed: progress.completed,
      total: progress.total,
      reused: progress.reused,
      error: progress.error,
      requests: progress.requests,
    });
    const becameCompleted =
      progress.status === 'completed' && this.lastStatus !== 'completed';
    this.lastStatus = progress.status;
    if (!becameCompleted) {
      return;
    }
    // A chunked chapter stalled without an apply (everything cached/dup) —
    // nudge the shell so pending `more` chains drain instead of hanging.
    if (this.moreRef.size > 0) {
      this.moreRef.clear();
      this.post({ kind: 'trCollect' });
    }
    this.onCompleted?.();
  }

  private handleRestored(): void {
    // Only a restore WE requested (or any non-running state) may reset the
    // coordinator — a stray event must never kill a live run.
    if (!this.pendingRestore && this.coordinator.status === 'running') {
      return;
    }
    this.pendingRestore = false;
    this.coordinator.restore();
  }

  private handleButton(action: string): void {
    switch (action) {
      case 'start':
        this.start();
        break;
      case 'pause':
        this.coordinator.pause();
        break;
      case 'resume':
        this.coordinator.resume();
        // Zeus parity: a failed batch is not re-queued internally; "متابعة"
        // re-collects untranslated paragraphs from the shell (memory answers
        // cached ones instantly, so no double billing).
        this.post({ kind: 'trCollect' });
        break;
      case 'restore':
        // Shell removes applied translations, then acks with trRestored —
        // the coordinator resets only then (screen text must match state).
        this.pendingRestore = true;
        this.post({ kind: 'trRestore' });
        break;
      case 'retranslate':
        this.pendingRestore = false;
        this.post({ kind: 'trRestore' });
        this.coordinator.restore();
        this.start();
        break;
      case 'dismiss':
        this.post({ kind: 'trOffer', visible: false });
        break;
      case 'dismissOffer':
        this.post({ kind: 'trOffer', visible: false });
        this.post({
          kind: 'trProgress',
          status: 'idle',
          completed: 0,
          total: 0,
          reused: 0,
          error: null,
          requests: 0,
        });
        break;
      case 'settings':
        this.openSettings();
        break;
      case 'showTranslation':
      default:
        // Shell-local display toggle (applied overlay visibility) — the RN
        // side has no state to change.
        break;
    }
  }

  private openSettings(): void {
    this.navigate?.('TranslationSettings');
  }

  // ------------------------------------------------------------- prefetch ---

  private async runPrefetch(ctx: PrefetchChapterContext): Promise<void> {
    // Network-idle-ish: let interactions drain, then a short cooldown, so
    // the prefetch never competes with visible work or chapter loads.
    await new Promise<void>(resolve => {
      InteractionManager.runAfterInteractions(() => resolve());
    });
    if (this.disposed) {
      return;
    }
    await new Promise<void>(resolve => {
      setTimeout(resolve, PREFETCH_IDLE_DELAY_MS);
    });
    if (this.disposed) {
      return;
    }

    const lines = [
      ...new Set(
        ctx.lines
          .map(line => line.trim())
          .filter(line => line.length > 0 && !isImageOnlyBlock(line)),
      ),
    ];
    if (lines.length === 0) {
      return;
    }

    await this.ensureMemory();
    // Namespace parity with the coordinator: `reader:{novel}:{chapter}#{wNum}`
    // + the same effective provider (glossary/custom instruction included).
    const namespace = memoryIdentity(
      `reader:${ctx.novelId}:${ctx.chapterId}#${ctx.wNum}`,
      this.prefs,
      this.effectiveProvider(),
    );
    const cached = await this.memory.lookup(namespace, lines);
    if (cached.size / lines.length >= PREFETCH_HIT_RATIO) {
      return; // already translated — skip
    }
    const missing = lines.filter(line => !cached.has(line));
    if (missing.length === 0) {
      return;
    }

    if (
      this.disposed ||
      this.coordinator.status === 'running' ||
      this.startPending
    ) {
      return;
    }
    let finish: () => void = () => {};
    const settled = new Promise<void>(resolve => {
      finish = resolve;
    });
    const coordinator = new ReaderTranslationCoordinator(
      this.prefs,
      this.providers,
      {
        memory: this.memory,
        budget: this.budget,
        translate: translateSegments,
        getSecret: readSecret,
        onApply: () => {},
        onProgress: progress => {
          if (
            this.disposed ||
            (progress.status !== 'running' && progress.status !== 'idle')
          ) {
            finish();
          }
        },
      },
    );
    this.prefetchCoordinator = coordinator;
    coordinator.addSegments(
      missing.map((text, index) => ({
        id: `pf${ctx.wNum}:${index}`,
        text,
        chapter: ctx.wNum,
        tier: 2,
        distance: 0,
      })),
      { novelId: String(ctx.novelId), chapterId: String(ctx.chapterId) },
    );
    await settled;
    this.prefetchCoordinator = null;
  }
}
