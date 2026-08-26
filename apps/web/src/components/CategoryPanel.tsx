import { useState } from 'react';
import type { Category } from '../api';
import { Icon } from './Icon';

interface Props {
  categories: Category[];
  busy: boolean;
  onCreate: (input: { name: string; color?: string; matchPattern?: string }) => void;
  onUpdate: (id: string, changes: Partial<Category>) => void;
  onDelete: (id: string) => void;
}

/**
 * Colours and groupings. Purely descriptive: changing a category never changes
 * what the scheduler is allowed to move.
 */
export function CategoryPanel({ categories, busy, onCreate, onUpdate, onDelete }: Props) {
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState('');
  const [adding, setAdding] = useState(false);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (name.trim().length === 0) return;
    onCreate({
      name: name.trim(),
      ...(pattern.trim() ? { matchPattern: pattern.trim() } : {}),
    });
    setName('');
    setPattern('');
    setAdding(false);
  };

  return (
    <section className="panel categories">
      <div className="panel-head">
        <h2>Categories</h2>
        <span className="badge count">{categories.length}</span>
        <span className="spacer" />
        <button
          className={adding ? 'small' : 'small primary'}
          onClick={() => setAdding((value) => !value)}
          disabled={busy}
          aria-expanded={adding}
        >
          <Icon name={adding ? 'close' : 'plus'} size={14} />
          {adding ? 'Cancel' : 'New'}
        </button>
      </div>

      {adding && (
        <form className="inline-form" onSubmit={submit}>
          <label className="field">
            <span>Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Deep work"
              autoFocus
            />
          </label>
          <label className="field">
            <span>Auto-match titles</span>
            <input
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
              placeholder="gym|run|yoga"
            />
            <small className="field-hint">
              A regular expression. Anything matching joins this category.
            </small>
          </label>
          <div className="inline-form-actions">
            <button type="submit" className="primary" disabled={busy || name.trim().length === 0}>
              Add category
            </button>
          </div>
        </form>
      )}

      <ul className="category-list">
        {categories.length === 0 && (
          <li className="empty">No categories yet. Add one to colour your calendar.</li>
        )}
        {categories.map((category) => (
          <li key={category.id} className="category">
            <input
              type="color"
              value={category.color}
              disabled={busy}
              aria-label={`Colour for ${category.name}`}
              title="Change colour"
              onChange={(event) => onUpdate(category.id, { color: event.target.value })}
            />
            <div className="category-main">
              <span className="category-name">
                {category.name}
                {category.isDefault && (
                  <span className="badge" title="Used for anything unmatched">
                    default
                  </span>
                )}
              </span>
              {category.matchPattern && (
                <code className="category-pattern" title={category.matchPattern}>
                  {category.matchPattern}
                </code>
              )}
            </div>
            <button
              className="icon small ghost"
              onClick={() => onDelete(category.id)}
              disabled={busy}
              aria-label={`Delete ${category.name}`}
              title="Delete; anything using it becomes uncategorised"
            >
              <Icon name="trash" size={14} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
