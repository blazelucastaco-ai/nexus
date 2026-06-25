import { AnimatePresence, motion } from 'framer-motion';
import { useUI } from '../lib/store';

// Top-left live activity feed: every tool/task/dream the brain runs slides in.
export function Feed() {
  const { feed } = useUI();
  if (!feed.length) return null;
  return (
    <div className="feed">
      <div className="feed-title">
        <span className="spark" />
        Activity
      </div>
      <AnimatePresence initial={false}>
        {feed.map((f) => (
          <motion.div
            key={f.id}
            layout
            initial={{ opacity: 0, x: -18, filter: 'blur(6px)' }}
            animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, x: -18, height: 0, marginBottom: 0 }}
            transition={{ duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
            className={`feed-row ${f.ok === true ? 'ok' : f.ok === false ? 'bad' : ''}`}
            title={f.detail || ''}
          >
            <span className="tick" />
            <span className="label">{f.label}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
