import type {
  Clock,
  Database,
  IdGenerator,
  Instant,
  Task,
  TaskId,
  UserId,
} from '@calendar-agent/core';
import { NotFoundError, ValidationError, makeTask, remainingMinutes } from '@calendar-agent/core';

export interface CreateTaskInput {
  readonly userId: UserId;
  readonly title: string;
  readonly description?: string;
  readonly estimatedMinutes: number;
  readonly deadline?: Instant;
  readonly earliestStart?: Instant;
  readonly latestStart?: Instant;
  readonly priority?: Task['priority'];
  readonly importance?: number;
  readonly minimumBlockMinutes?: number;
  readonly maximumBlockMinutes?: number;
  readonly allowSplitting?: boolean;
  readonly focus?: Task['focus'];
  readonly tags?: readonly string[];
  readonly dependsOn?: readonly TaskId[];
  readonly projectId?: string;
  readonly calendarId?: string;
  readonly preferredWindows?: Task['preferredWindows'];
  readonly preferredDays?: Task['preferredDays'];
  readonly pinned?: boolean;
}

export type UpdateTaskInput = Partial<Omit<CreateTaskInput, 'userId'>> & {
  readonly status?: Task['status'];
  readonly completedMinutes?: number;
};

/** Task CRUD plus the reference resolution the agent and CLI rely on. */
export class TaskService {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async create(input: CreateTaskInput): Promise<Task> {
    if (input.estimatedMinutes <= 0) {
      throw new ValidationError('A task needs a positive estimated duration.');
    }
    if (input.deadline !== undefined && input.earliestStart !== undefined) {
      if (input.deadline <= input.earliestStart) {
        throw new ValidationError('The deadline must be after the earliest start time.');
      }
    }
    const now = this.clock.now();
    const task = makeTask({
      id: this.ids.next('task'),
      userId: input.userId,
      title: input.title.trim(),
      ...stripUndefined(input),
      createdAt: now,
      updatedAt: now,
    });
    return this.db.tasks.save(task);
  }

  async get(id: TaskId): Promise<Task> {
    const task = await this.db.tasks.get(id);
    if (!task) throw new NotFoundError('task', id);
    return task;
  }

  async list(userId: UserId, options: { includeCompleted?: boolean } = {}): Promise<Task[]> {
    const tasks = await this.db.tasks.list({ userId });
    return options.includeCompleted
      ? tasks
      : tasks.filter((task) => task.status !== 'completed' && task.status !== 'cancelled');
  }

  async update(id: TaskId, changes: UpdateTaskInput): Promise<Task> {
    const task = await this.get(id);
    const next: Task = {
      ...task,
      ...stripUndefined(changes),
      updatedAt: this.clock.now(),
    };
    if (next.estimatedMinutes <= 0) {
      throw new ValidationError('A task needs a positive estimated duration.');
    }
    return this.db.tasks.save(next);
  }

  async complete(id: TaskId, completedMinutes?: number): Promise<Task> {
    const task = await this.get(id);
    const now = this.clock.now();
    return this.db.tasks.save({
      ...task,
      status: 'completed',
      completedMinutes: completedMinutes ?? task.estimatedMinutes,
      completedAt: now,
      updatedAt: now,
    });
  }

  async logProgress(id: TaskId, minutes: number): Promise<Task> {
    const task = await this.get(id);
    const completed = Math.min(task.estimatedMinutes, task.completedMinutes + minutes);
    return this.db.tasks.save({
      ...task,
      completedMinutes: completed,
      status: completed >= task.estimatedMinutes ? 'completed' : 'in_progress',
      updatedAt: this.clock.now(),
    });
  }

  async delete(id: TaskId): Promise<void> {
    const blocks = await this.db.blocks.list({
      userId: (await this.get(id)).userId,
      taskIds: [id],
    });
    await this.db.blocks.deleteMany(blocks.map((block) => block.id));
    await this.db.tasks.delete(id);
  }

  /**
   * Resolve an id or a title fragment to a task. Exact id wins, then exact
   * title, then a unique case-insensitive substring match.
   */
  async resolve(userId: UserId, reference: string): Promise<Task> {
    const trimmed = reference.trim();
    const byId = await this.db.tasks.get(trimmed);
    if (byId && byId.userId === userId) return byId;

    const tasks = await this.db.tasks.list({ userId });
    const lower = trimmed.toLowerCase();

    // Ids are UUIDs, so a unique prefix (as printed by the CLI) is enough.
    if (trimmed.length >= 4) {
      const byPrefix = tasks.filter((task) => task.id.includes(trimmed));
      if (byPrefix.length === 1) return byPrefix[0]!;
    }

    const exact = tasks.filter((task) => task.title.toLowerCase() === lower);
    if (exact.length === 1) return exact[0]!;

    const partial = tasks.filter((task) => task.title.toLowerCase().includes(lower));
    if (partial.length === 1) return partial[0]!;
    if (partial.length > 1) {
      const open = partial.filter((task) => task.status !== 'completed');
      if (open.length === 1) return open[0]!;
      throw new ValidationError(
        `"${reference}" matches ${partial.length} tasks. Use the task id instead.`,
        { details: { candidates: partial.map((task) => ({ id: task.id, title: task.title })) } },
      );
    }
    throw new NotFoundError('task', reference);
  }

  remaining(task: Task): number {
    return remainingMinutes(task);
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
