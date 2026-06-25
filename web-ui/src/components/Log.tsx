import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useUI } from '../lib/store';

// Bottom-center running transcript. Recent turns; older ones fade out the top.
export function Log() {
  const { messages } = useUI();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  if (!messages.length) return null;
  // Show the last several turns; the orb caption carries the freshest reply.
  const recent = messages.slice(-8);
  return (
    <div className="log" ref={ref}>
      <AnimatePresence initial={false}>
        {recent.map((m) => (
          <motion.div
            key={m.id}
            layout
            initial={{ opacity: 0, y: 14, filter: 'blur(6px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            className={`msg ${m.role}`}
          >
            <span className="bubble">{m.text}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
