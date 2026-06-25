import { AnimatePresence, motion } from 'framer-motion';
import { useUI } from '../lib/store';

// Proactive nudges, dream reflections and idle ideas surfaced from the brain's
// background loops — they rise from the bottom-left and fade on their own.
export function Toasts() {
  const { toasts } = useUI();
  return (
    <div className="toasts">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 22, scale: 0.96, filter: 'blur(8px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, x: -24, filter: 'blur(6px)' }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className={`toast ${t.level}`}
          >
            <span className="bar" />
            <span>{t.text}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
