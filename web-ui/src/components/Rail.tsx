import { AnimatePresence, motion } from 'framer-motion';
import { ui, useUI, type Card } from '../lib/store';
import { Chart } from '../cards/Chart';
import { Diagram } from '../cards/Diagram';
import { Panel } from '../cards/Panel';
import { Projects } from '../cards/Projects';

const FALLBACK_TITLE: Record<Card['kind'], string> = {
  chart: 'Chart',
  diagram: 'Diagram',
  panel: 'Note',
  projects: 'Projects',
};

function renderCard(card: Card) {
  switch (card.kind) {
    case 'chart': return <Chart payload={card.payload} />;
    case 'diagram': return <Diagram payload={card.payload} />;
    case 'projects': return <Projects payload={card.payload} />;
    default: return <Panel payload={card.payload} />;
  }
}

// The right rail: charts / diagrams / panels / projects the model conjures.
export function Rail() {
  const { cards } = useUI();
  if (!cards.length) return null;
  return (
    <div className="rail">
      <AnimatePresence initial={false}>
        {cards.map((c) => {
          const title = String(c.payload.title ?? FALLBACK_TITLE[c.kind]);
          return (
            <motion.div
              key={c.id}
              layout
              initial={{ opacity: 0, x: 44, scale: 0.95, filter: 'blur(12px)' }}
              animate={{ opacity: 1, x: 0, scale: 1, filter: 'blur(0px)' }}
              exit={{ opacity: 0, x: 44, scale: 0.95, filter: 'blur(8px)' }}
              transition={{ duration: 0.52, ease: [0.16, 1, 0.3, 1] }}
              className="panel"
            >
              <div className="panel-head">
                <span className="spark" />
                <span>{title}</span>
                <button className="panel-x" onClick={() => ui.removeCard(c.id)} aria-label="Dismiss">
                  ×
                </button>
              </div>
              <div className="panel-body">{renderCard(c)}</div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
