import { AnimatePresence, motion } from 'framer-motion';
import { useUI } from '../lib/store';

// The "thinking… / running a task…" line just below the orb.
export function StatusLine() {
  const { status } = useUI();
  return (
    <AnimatePresence>
      {status ? (
        <motion.div
          className="statusline"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        >
          <span className="dot" />
          {status}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
