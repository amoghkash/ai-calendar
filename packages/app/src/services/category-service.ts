import type {
  CalendarEvent,
  Category,
  Clock,
  Database,
  IdGenerator,
  ScheduleBlock,
  Task,
  UserId,
} from '@calendar-agent/core';
import {
  CATEGORY_PALETTE,
  DEFAULT_CATEGORIES,
  NotFoundError,
  ValidationError,
  normaliseColor,
  resolveCategory,
} from '@calendar-agent/core';

export interface CategoryInput {
  readonly name: string;
  readonly color?: string;
  readonly description?: string;
  readonly matchPattern?: string;
  readonly calendarId?: string;
  readonly isDefault?: boolean;
  readonly position?: number;
}

/** A category paired with what it currently applies to. */
export interface CategoryUsage {
  readonly category: Category;
  readonly taskCount: number;
  readonly eventCount: number;
}

/**
 * User-defined colours and groupings for tasks and events.
 *
 * Purely descriptive: a category never affects what the scheduler is allowed
 * to move. That decision belongs to `EventClassification`.
 */
export class CategoryService {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  list(userId: UserId): Promise<Category[]> {
    return this.db.categories.list(userId);
  }

  async get(id: string): Promise<Category> {
    const category = await this.db.categories.get(id);
    if (!category) throw new NotFoundError('category', id);
    return category;
  }

  async create(userId: UserId, input: CategoryInput): Promise<Category> {
    const name = input.name.trim();
    if (name.length === 0) throw new ValidationError('A category needs a name.');
    const existing = await this.db.categories.list(userId);
    if (existing.some((category) => category.name.toLowerCase() === name.toLowerCase())) {
      throw new ValidationError(`A category called "${name}" already exists.`);
    }
    this.assertValidPattern(input.matchPattern);

    const now = this.clock.now();
    const category: Category = {
      id: this.ids.next('cat'),
      userId,
      name,
      color: input.color ? normaliseColor(input.color) : this.nextColor(existing),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.matchPattern === undefined ? {} : { matchPattern: input.matchPattern }),
      ...(input.calendarId === undefined ? {} : { calendarId: input.calendarId }),
      isDefault: input.isDefault ?? false,
      position: input.position ?? existing.length,
      createdAt: now,
      updatedAt: now,
    };

    if (category.isDefault) await this.clearOtherDefaults(userId, category.id);
    return this.db.categories.save(category);
  }

  async update(id: string, changes: Partial<CategoryInput>): Promise<Category> {
    const category = await this.get(id);
    this.assertValidPattern(changes.matchPattern);
    const next: Category = {
      ...category,
      ...(changes.name === undefined ? {} : { name: changes.name.trim() }),
      ...(changes.color === undefined ? {} : { color: normaliseColor(changes.color) }),
      ...(changes.description === undefined ? {} : { description: changes.description }),
      ...(changes.matchPattern === undefined ? {} : { matchPattern: changes.matchPattern }),
      ...(changes.calendarId === undefined ? {} : { calendarId: changes.calendarId }),
      ...(changes.isDefault === undefined ? {} : { isDefault: changes.isDefault }),
      ...(changes.position === undefined ? {} : { position: changes.position }),
      updatedAt: this.clock.now(),
    };
    if (next.isDefault) await this.clearOtherDefaults(category.userId, category.id);
    return this.db.categories.save(next);
  }

  /**
   * Delete a category and unassign everything pointing at it, so nothing is
   * left referencing an id that no longer exists.
   */
  async delete(
    id: string,
  ): Promise<{ readonly tasksUnassigned: number; readonly eventsUnassigned: number }> {
    const category = await this.get(id);
    const tasks = (await this.db.tasks.list({ userId: category.userId })).filter(
      (task) => task.categoryId === id,
    );
    for (const task of tasks) {
      await this.db.tasks.save({ ...task, categoryId: undefined, updatedAt: this.clock.now() });
    }

    const events = (
      await this.db.events.list({
        userId: category.userId,
        range: { start: 0, end: Number.MAX_SAFE_INTEGER },
      })
    ).filter((event) => event.categoryId === id);
    for (const event of events) {
      await this.db.events.save({ ...event, categoryId: undefined });
    }

    await this.db.categories.delete(id);
    return { tasksUnassigned: tasks.length, eventsUnassigned: events.length };
  }

  /** Give a new user something to work with; entirely editable afterwards. */
  async seedDefaults(userId: UserId): Promise<Category[]> {
    const existing = await this.db.categories.list(userId);
    if (existing.length > 0) return existing;

    const created: Category[] = [];
    for (const [index, seed] of DEFAULT_CATEGORIES.entries()) {
      created.push(
        await this.create(userId, {
          name: seed.name,
          color: seed.color,
          position: index,
          ...(seed.matchPattern === undefined ? {} : { matchPattern: seed.matchPattern }),
          ...(seed.isDefault === undefined ? {} : { isDefault: seed.isDefault }),
        }),
      );
    }
    return created;
  }

  /** Which category applies to an event, and therefore which colour it takes. */
  async resolveForEvent(
    userId: UserId,
    event: Pick<CalendarEvent, 'title' | 'calendarId' | 'categoryId'>,
  ): Promise<Category | undefined> {
    return resolveCategory(event, await this.db.categories.list(userId));
  }

  /**
   * Colour for every task and event in one lookup, so the UI can paint the
   * grid without an N+1 round trip.
   */
  async colorMap(
    userId: UserId,
    tasks: readonly Task[],
    events: readonly CalendarEvent[],
    blocks: readonly ScheduleBlock[],
  ): Promise<{
    readonly categories: Category[];
    readonly byTask: Record<string, string>;
    readonly byEvent: Record<string, string>;
    readonly byBlock: Record<string, string>;
  }> {
    const categories = await this.db.categories.list(userId);
    const byId = new Map(categories.map((category) => [category.id, category]));

    const byTask: Record<string, string> = {};
    for (const task of tasks) {
      const category =
        (task.categoryId === undefined ? undefined : byId.get(task.categoryId)) ??
        resolveCategory({ title: task.title }, categories);
      if (category) byTask[task.id] = category.id;
    }

    const byEvent: Record<string, string> = {};
    for (const event of events) {
      const category = resolveCategory(event, categories);
      if (category) byEvent[event.id] = category.id;
    }

    // A block inherits its task's category: they are the same piece of work.
    const byBlock: Record<string, string> = {};
    for (const block of blocks) {
      const categoryId = byTask[block.taskId];
      if (categoryId !== undefined) byBlock[block.id] = categoryId;
    }

    return { categories, byTask, byEvent, byBlock };
  }

  /**
   * How many tasks and events each category currently covers.
   *
   * Counts *resolved* membership, not just explicit assignments: a category
   * that matches by pattern colours those items in the UI, so reporting zero
   * for it would contradict what the user sees.
   */
  async usage(userId: UserId): Promise<CategoryUsage[]> {
    const [categories, tasks, events] = await Promise.all([
      this.db.categories.list(userId),
      this.db.tasks.list({ userId }),
      this.db.events.list({ userId, range: { start: 0, end: Number.MAX_SAFE_INTEGER } }),
    ]);

    const tally = new Map<string, { tasks: number; events: number }>(
      categories.map((category) => [category.id, { tasks: 0, events: 0 }]),
    );

    for (const task of tasks) {
      const resolved = resolveCategory(
        {
          title: task.title,
          ...(task.categoryId === undefined ? {} : { categoryId: task.categoryId }),
        },
        categories,
      );
      if (resolved) tally.get(resolved.id)!.tasks += 1;
    }
    for (const event of events) {
      const resolved = resolveCategory(event, categories);
      if (resolved) tally.get(resolved.id)!.events += 1;
    }

    return categories.map((category) => ({
      category,
      taskCount: tally.get(category.id)?.tasks ?? 0,
      eventCount: tally.get(category.id)?.events ?? 0,
    }));
  }

  private async clearOtherDefaults(userId: UserId, keepId: string): Promise<void> {
    for (const other of await this.db.categories.list(userId)) {
      if (other.id !== keepId && other.isDefault) {
        await this.db.categories.save({ ...other, isDefault: false });
      }
    }
  }

  private assertValidPattern(pattern: string | undefined): void {
    if (pattern === undefined) return;
    try {
      new RegExp(pattern, 'i');
    } catch {
      throw new ValidationError(`"${pattern}" is not a valid regular expression.`);
    }
  }

  private nextColor(existing: readonly Category[]): string {
    const used = new Set(existing.map((category) => category.color));
    return CATEGORY_PALETTE.find((color) => !used.has(color)) ?? CATEGORY_PALETTE[0]!;
  }
}
