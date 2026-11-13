import type { AIProviderConfiguration } from './providerTypes';
import {
  TranslationFailure,
  keepsTranslations,
  memoryIdentity,
  type TranslationPreferences,
} from './types';
import { TranslationMemory } from './memory';
import { translateSegments } from './textService';
import { providerById } from './prefs';
import { clampMaxRequests, planAIParts, limitsForProvider } from './aiPolicy';
import { dailyLimitReached } from './usage';
import { AIChapterBudget } from './chapterBudget';

// Port of Zeus Ascent Edition: ZEUSNext/ReaderTranslation.swift — the batch
// loop, visible-priority tiers, session caps and guards, restructured as a
// driver class that a React Native screen feeds collect results into and
// receives apply/progress events from. No RN imports here: fully unit-testable.

export interface CollectedSegment {
  id: string;
  text: string;
  tier: number; // 0 = intersecting viewport, 1 = near, 2 = far (Zeus tiers)
  distance: number;
  scope?: CoordinatorScope;
  chapter: number; // wor section number (data-ch)
}

export interface CoordinatorApplyItem {
  id: string;
  text: string;
  chapter: number;
}

export type CoordinatorStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'error';

export interface CoordinatorProgress {
  status: CoordinatorStatus;
  completed: number;
  total: number;
  reused: number;
  error: string | null;
  // v3: real model requests spent during this run (AI engine). 0 for
  // metered engines — the reader card hides the counter then.
  requests: number;
}

export interface CoordinatorScope {
  novelId: string;
  chapterId: string;
}

export interface CoordinatorDeps {
  memory: TranslationMemory;
  translate: typeof translateSegments;
  getSecret: (key: string) => Promise<string>;
  onApply: (items: CoordinatorApplyItem[]) => void;
  onProgress: (progress: CoordinatorProgress) => void;
  budget?: AIChapterBudget;
  yieldSlice?: () => Promise<void>; // injection point for InteractionManager
}

// Zeus ReaderTranslation constants (verbatim):
const VISIBLE_CHAR_LIMIT = 24_000;
const VISIBLE_ITEM_LIMIT = 256;
const BACKGROUND_CHAR_LIMIT = 10_000;
const BACKGROUND_ITEM_LIMIT = 64;
const SESSION_CHAR_GUARD = 500_000;

export class ReaderTranslationCoordinator {
  private queue: CollectedSegment[] = [];
  private known = new Set<string>();
  private epoch = 0;
  private session = 0;
  private processedCharacters = 0;
  private completed = 0;
  private reused = 0;
  private total = 0;
  private statusValue: CoordinatorStatus = 'idle';
  private errorValue: string | null = null;
  private pumping = false;
  private pending = false;
  private lastScope: CoordinatorScope = { novelId: '', chapterId: '' };
  private requestsCount = 0;
  // Approval covers the exact planned total, not every future retry.
  private approval: { key: string; total: number } | null = null;
  private readonly budget: AIChapterBudget;
  private abortController = new AbortController();

  constructor(
    private readonly prefs: TranslationPreferences,
    private readonly providers: AIProviderConfiguration[],
    private readonly deps: CoordinatorDeps,
  ) {
    this.budget = deps.budget ?? new AIChapterBudget();
  }

  get status(): CoordinatorStatus {
    return this.statusValue;
  }

  setScope(scope: CoordinatorScope): void {
    this.lastScope = scope;
  }

  private progress(): CoordinatorProgress {
    return {
      status: this.statusValue,
      completed: this.completed,
      total: this.total,
      reused: this.reused,
      error: this.errorValue,
      requests: this.requestsCount,
    };
  }

  private emit(): void {
    this.deps.onProgress(this.progress());
  }

  private fail(message: string): void {
    // Zeus: errors keep already-applied translations on screen.
    this.statusValue = 'error';
    this.errorValue = message;
    this.epoch += 1;
    this.emit();
  }

  private provider(): AIProviderConfiguration | null {
    return providerById(this.providers, this.prefs.providerID);
  }

  // Effective AI provider: glossary + custom style ride on the instruction,
  // exactly where Zeus carried its style instruction. Non-AI engines never
  // see instructions (they have no parameter for them).
  private effectiveProvider(): AIProviderConfiguration | null {
    const provider = this.provider();
    if (!provider || this.prefs.engine !== 'ai') return provider;
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

  // New collect result arriving from the WebView shell.
  addSegments(segments: CollectedSegment[], scope: CoordinatorScope): void {
    this.lastScope = scope;
    if (this.statusValue === 'completed' || this.statusValue === 'error') {
      this.statusValue = 'idle';
      this.errorValue = null;
    }
    const fresh: CollectedSegment[] = [];
    for (const segment of segments) {
      if (this.known.has(segment.id)) continue;
      if (segment.text.trim().length === 0) continue;
      this.known.add(segment.id);
      fresh.push({ ...segment, scope });
    }
    if (fresh.length === 0) return;
    this.queue.push(...fresh);
    this.total += fresh.length;
    if (this.statusValue === 'idle') {
      this.statusValue = 'running';
      this.errorValue = null;
    }
    this.emit();
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      this.pending = true;
      return;
    }
    this.pumping = true;
    const ticket = this.epoch;
    const session = this.session;
    // The batch currently taken out of the queue. If the round aborts or
    // fails, it must go BACK to the queue — Zeus could always re-collect from
    // the live page; this coordinator owns the queue instead.
    let inflight: CollectedSegment[] = [];
    const appliedIds = new Set<string>();
    const requeue = (): void => {
      if (session !== this.session) return;
      const lost = inflight.filter(segment => !appliedIds.has(segment.id));
      if (lost.length > 0) this.queue = lost.concat(this.queue);
      inflight = [];
    };
    try {
      while (this.queue.length > 0 && this.statusValue === 'running') {
        if (ticket !== this.epoch) return;
        if (this.processedCharacters >= SESSION_CHAR_GUARD) {
          this.queue = [];
          this.fail(
            'حجم الترجمة في هذه الجلسة تجاوز الحد الآمن. اضغط متابعة لاستكمال بقية الفصل.',
          );
          return;
        }
        if (this.prefs.engine !== 'ai') {
          this.queue.sort((a, b) => {
            if (a.tier !== b.tier) return a.tier - b.tier;
            if (a.distance !== b.distance) return a.distance - b.distance;
            return a.id < b.id ? -1 : 1;
          });
        }
        const visible = this.queue[0].tier === 0;
        // AI always plans a full chapter. Viewport tiers only apply to
        // metered translation engines, where multiple small rounds are cheap.
        const aiWholeChapter = this.prefs.engine === 'ai';
        const charLimit = aiWholeChapter
          ? Infinity
          : visible
          ? VISIBLE_CHAR_LIMIT
          : BACKGROUND_CHAR_LIMIT;
        const itemLimit = aiWholeChapter
          ? Infinity
          : visible
          ? VISIBLE_ITEM_LIMIT
          : BACKGROUND_ITEM_LIMIT;
        const batch: CollectedSegment[] = [];
        let size = 0;
        let cutIndex = 0;
        while (cutIndex < this.queue.length && batch.length < itemLimit) {
          const segment = this.queue[cutIndex];
          if (segment.chapter !== this.queue[0].chapter) break;
          if (!aiWholeChapter && visible && segment.tier !== 0) break; // never mix tiers in a visible round
          if (
            batch.length > 0 &&
            size + Array.from(segment.text).length > charLimit
          ) {
            break;
          }
          batch.push(segment);
          size += Array.from(segment.text).length;
          cutIndex += 1;
        }
        if (batch.length === 0) return;
        this.queue = this.queue.slice(cutIndex);
        inflight = batch;

        const chapter = batch[0].chapter;
        const scope = batch[0].scope ?? this.lastScope;
        const ns = memoryIdentity(
          `reader:${scope.novelId}:${chapterIdOf(chapter, scope.chapterId)}`,
          this.prefs,
          this.effectiveProvider(),
        );
        const budgetKey = JSON.stringify(ns);
        const cached = await this.deps.memory.lookup(
          ns,
          batch.map(row => row.text),
        );
        if (ticket !== this.epoch) {
          requeue();
          return;
        }
        this.reused += cached.size;
        const missing = batch
          .filter(row => !cached.has(row.text))
          // Repeated lines are billed once per batch (Zeus dedupe rule).
          .filter(
            (row, index, all) =>
              all.findIndex(other => other.text === row.text) === index,
          );
        const freshResults = new Map<string, string>();
        const applyItems = (items: CoordinatorApplyItem[]): void => {
          if (items.length === 0) return;
          this.deps.onApply(items);
          for (const item of items) appliedIds.add(item.id);
          this.completed += items.length;
          this.emit();
        };
        const buildItems = (
          rows: CollectedSegment[],
          results: Map<string, string>,
        ) =>
          rows.flatMap(row => {
            if (appliedIds.has(row.id)) return []; // already applied (streaming/part)
            const text = results.get(row.text);
            return text === undefined
              ? []
              : [{ id: row.id, text, chapter: row.chapter }];
          });
        if (missing.length > 0) {
          this.processedCharacters += batch.reduce(
            (sum, row) => sum + Array.from(row.text).length,
            0,
          );
          const context = {
            signal: this.abortController.signal,
            prefs: this.prefs,
            provider: this.effectiveProvider(),
            secret: await this.deps.getSecret(
              secretKeyFor(this.prefs, this.provider()),
            ),
          };
          if (aiWholeChapter) {
            // ---- v3 AI policy: whole chapter, few large parts ------------
            const limits = limitsForProvider(context.provider);
            const plan = planAIParts(missing, {
              ...limits,
              maxRequestsPerChapter: clampMaxRequests(
                this.prefs.aiMaxRequestsPerChapter,
              ),
            });
            const required = this.budget.spent(budgetKey) + plan.requests;
            if (
              required >
              this.budget.allowance(
                budgetKey,
                this.prefs.aiMaxRequestsPerChapter,
              )
            ) {
              this.approval = { key: budgetKey, total: required };
              // Do NOT spend without consent: keep the batch, pause, ask.
              requeue();
              this.statusValue = 'paused';
              this.errorValue = `سيصل مجموع محاولات هذا الفصل إلى ${required} طلبات (أُرسل ${this.budget.spent(
                budgetKey,
              )}). اضغط متابعة للموافقة على ${
                plan.requests
              } طلبات إضافية، أو اختر نموذجًا أكبر.`;
              this.emit();
              return;
            }
            const streamEnabled =
              this.prefs.aiStreaming === true &&
              (context.provider?.kind === 'openAICompatible' ||
                context.provider?.kind === 'geminiAPI');
            for (const [from, to] of plan.parts) {
              if (ticket !== this.epoch) {
                requeue();
                return;
              }
              if (dailyLimitReached(this.prefs.aiDailyRequestLimit)) {
                requeue();
                this.statusValue = 'paused';
                this.errorValue = `وصلتَ إلى الحد اليومي لطلبات الذكاء الاصطناعي (${this.prefs.aiDailyRequestLimit}). يمكن رفع الحد أو تعطيله من إعدادات الترجمة.`;
                this.emit();
                return;
              }
              const part = missing.slice(from, to);
              // Count the request when it STARTS — failed attempts were
              // spent against the provider just like successful ones.
              if (
                this.budget.spent(budgetKey) >=
                this.budget.allowance(
                  budgetKey,
                  this.prefs.aiMaxRequestsPerChapter,
                )
              ) {
                this.approval = {
                  key: budgetKey,
                  total: this.budget.spent(budgetKey) + plan.parts.length,
                };
                requeue();
                this.statusValue = 'paused';
                this.errorValue =
                  'وصل هذا الفصل إلى حد الطلبات. اضغط متابعة للموافقة على طلبات إضافية.';
                this.emit();
                return;
              }
              const translated = await this.deps.translate(
                part.map(row => ({ id: row.id, text: row.text })),
                {
                  ...context,
                  onRequest: () => {
                    this.budget.reserve(budgetKey);
                    this.requestsCount = this.budget.spent(budgetKey);
                    this.emit();
                  },
                  limits: {
                    characterLimit: limits.maxCharsPerPart,
                    itemLimit: limits.maxSegmentsPerPart,
                  },
                  stream: streamEnabled,
                  onPartial: streamEnabled
                    ? item => {
                        // Instant translation: apply + persist each item as
                        // it arrives, before the request even finishes.
                        if (ticket !== this.epoch) return;
                        const source = part.find(row => row.id === item.id);
                        if (!source || appliedIds.has(source.id)) return;
                        this.deps.onApply([
                          {
                            id: source.id,
                            text: item.text,
                            chapter: source.chapter,
                          },
                        ]);
                      }
                    : undefined,
                },
              );
              if (ticket !== this.epoch) {
                requeue();
                return;
              }
              for (const item of translated) {
                const source = part.find(row => row.id === item.id);
                if (source) freshResults.set(source.text, item.text);
              }
              if (keepsTranslations(this.prefs)) {
                const partSave = new Map<string, string>();
                for (const item of translated) {
                  const source = part.find(row => row.id === item.id);
                  if (source) partSave.set(source.text, item.text);
                }
                await this.deps.memory.save(ns, partSave, {
                  novelId: scope.novelId,
                  chapterId: scope.chapterId,
                  engine: this.prefs.engine,
                  target: this.prefs.target,
                });
              }
              // Apply THIS part before paying for the next one.
              applyItems(buildItems(part, freshResults));
              await (this.deps.yieldSlice?.() ??
                new Promise<void>(resolve => setTimeout(resolve, 0)));
            }
          } else {
            const translated = await this.deps.translate(
              missing.map(row => ({ id: row.id, text: row.text })),
              context,
            );
            if (ticket !== this.epoch) {
              requeue();
              return;
            }
            for (const item of translated) {
              const source = missing.find(row => row.id === item.id);
              if (source) freshResults.set(source.text, item.text);
            }
            if (keepsTranslations(this.prefs)) {
              await this.deps.memory.save(ns, freshResults, {
                novelId: scope.novelId,
                chapterId: scope.chapterId,
                engine: this.prefs.engine,
                target: this.prefs.target,
              });
            }
          }
        }
        if (ticket !== this.epoch) {
          requeue();
          return;
        }
        const results = new Map([...cached, ...freshResults]);
        applyItems(buildItems(batch, results));
        inflight = [];
        this.emit();
        // Let the UI breathe between batches (Zeus Task.yield equivalent).
        await (this.deps.yieldSlice?.() ??
          new Promise<void>(resolve => setTimeout(resolve, 0)));
      }
      if (
        this.statusValue === 'running' &&
        this.queue.length === 0 &&
        !this.pending
      ) {
        this.statusValue = 'completed';
        this.emit();
      }
    } catch (error) {
      if (ticket !== this.epoch) {
        requeue();
        return;
      }
      // Failed batch goes back to the queue so "متابعة" retries it.
      requeue();
      const message =
        error instanceof TranslationFailure
          ? error.message
          : `تعذر إكمال الترجمة. تحقق من الشبكة أو المزود. (${
              (error as Error)?.message ?? 'خطأ غير معروف'
            })`;
      this.statusValue = 'paused';
      this.errorValue = message;
      this.emit();
    } finally {
      this.pumping = false;
      if (this.pending && this.statusValue === 'running') {
        this.pending = false;
        void this.pump();
      } else {
        this.pending = false;
      }
    }
  }

  pause(): void {
    // Zeus pause: invalidates the in-flight ticket, keeps queued work for
    // resume, surfaces a resumable state.
    this.epoch += 1;
    this.abortController.abort();
    this.abortController = new AbortController();
    if (this.statusValue === 'running') {
      this.statusValue = 'paused';
      this.errorValue = 'أُوقفت الترجمة. يمكنك المتابعة أو عرض الأصل.';
      this.emit();
    }
  }

  resume(): void {
    if (this.statusValue !== 'paused') return;
    // Resuming past the "needs more requests" pause = explicit approval to
    // spend the additional requests for this run.
    if (this.approval) {
      this.budget.approve(this.approval.key, this.approval.total);
      this.approval = null;
    }
    this.errorValue = null;
    this.statusValue = 'running';
    this.emit();
    void this.pump();
  }

  restore(): void {
    this.session += 1;
    this.epoch += 1;
    this.abortController.abort();
    this.abortController = new AbortController();
    this.queue = [];
    this.known = new Set();
    this.total = 0;
    this.completed = 0;
    this.reused = 0;
    this.processedCharacters = 0;
    this.requestsCount = 0;
    this.approval = null;
    this.statusValue = 'idle';
    this.errorValue = null;
    this.emit();
  }

  invalidateSession(): void {
    // Namespace changed (engine/provider/target): drop queued + session state,
    // keep applied text until the user re-translates (Zeus behaviour).
    this.deps.memory.resetSession();
    this.restore();
  }
}

const chapterIdOf = (chapter: number, fallback: string): string =>
  fallback.length > 0 ? `${fallback}#${chapter}` : fallback;

const secretKeyFor = (
  prefs: TranslationPreferences,
  provider: AIProviderConfiguration | null,
): string => {
  switch (prefs.engine) {
    case 'microsoftVisco':
      return '';
    case 'googleCloud':
      return 'google-cloud';
    case 'cloudflare':
      return 'cloudflare-workers-ai';
    default:
      return provider?.id ?? '';
  }
};
