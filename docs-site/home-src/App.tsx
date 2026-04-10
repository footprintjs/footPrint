import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ChevronRight, ExternalLink, Sun, Moon, Menu, X, BookOpen, Play, Boxes, Code2 } from "lucide-react";

function Github({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>;
}

// ═══════════════════════════════════════════════════════════════════
// THEME
// ═══════════════════════════════════════════════════════════════════

function useTheme() {
  const [dark, setDark] = useState(() => typeof window !== "undefined" ? !document.documentElement.classList.contains("light") : true);
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); document.documentElement.classList.toggle("light", !dark); }, [dark]);
  return { dark, toggle: useCallback(() => setDark((d) => !d), []) };
}

// ═══════════════════════════════════════════════════════════════════
// SHARED PRIMITIVES
// ═══════════════════════════════════════════════════════════════════

const NAV_ITEMS = [
  { id: "problem", label: "Problem" },
  { id: "how", label: "How it works" },
  { id: "start", label: "Quick start" },
  { id: "explore", label: "Explore" },
];

function FootprintIcon({ className, size = 24 }: { className?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <ellipse cx="22" cy="10" rx="5" ry="6" strokeWidth="2.5" />
      <ellipse cx="36" cy="6" rx="4.5" ry="5.5" strokeWidth="2.5" />
      <ellipse cx="47" cy="12" rx="4" ry="5" strokeWidth="2.5" />
      <ellipse cx="53" cy="24" rx="3.5" ry="4.5" strokeWidth="2.5" />
      <path d="M44 34 C44 34, 46 50, 38 56 C30 62, 18 58, 16 50 C14 42, 18 34, 26 32 C34 30, 44 34, 44 34Z" strokeWidth="2.5" />
    </svg>
  );
}

function BrandName({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const cls = { sm: "text-base", md: "text-lg", lg: "text-2xl" }[size];
  return (<span className={cn("font-bold tracking-tight", cls)}><span className="uppercase">FOOTPRINT</span><span className="text-primary font-semibold" style={{ fontSize: "0.7em" }}>js</span></span>);
}

function SectionTitle({ id, badge, title, sub }: { id: string; badge: string; title: string; sub: string }) {
  return (
    <div id={id} className="text-center mb-12 scroll-mt-20">
      <span className="inline-block text-xs font-semibold tracking-widest uppercase text-primary mb-3">{badge}</span>
      <h2 className="text-3xl sm:text-4xl font-bold mb-3">{title}</h2>
      <p className="text-muted-foreground max-w-xl mx-auto">{sub}</p>
    </div>
  );
}

// ── Syntax highlighter ─────────────────────────────────────────────

function SyntaxBlock({ children, className }: { children: string; className?: string }) {
  const tokenize = (code: string): ReactNode[] => {
    const rules: [RegExp, string][] = [
      [/\/\/[^\n]*/, "dark:text-zinc-500 text-zinc-400 italic"],
      [/'[^']*'|"[^"]*"/, "dark:text-green-300 text-green-700"],
      [/\b(import|from|export|const|let|async|await|return|if|else|new|type|interface)\b/, "dark:text-purple-400 text-purple-600 font-semibold"],
      [/\b(true|false|null|undefined)\b/, "dark:text-orange-300 text-orange-600"],
      [/\b\d+(\.\d+)?\b/, "dark:text-orange-300 text-orange-600"],
      [/\b(string|number|boolean|void)\b/, "dark:text-cyan-300 text-cyan-600"],
      [/\b(flowChart|FlowChartExecutor|decide|enableNarrative|getNarrative|getNarrativeEntries|attachRecorder|MetricRecorder|narrative|addFunction|addDeciderFunction|addFunctionBranch|setDefault|end|build|run|scope|executor|rec)\b/, "dark:text-blue-300 text-blue-600"],
    ];
    const combined = new RegExp(rules.map(([r]) => `(${r.source})`).join("|"), "gm");
    const result: ReactNode[] = [];
    let last = 0, key = 0;
    for (const m of code.matchAll(combined)) {
      if (m.index! > last) result.push(code.slice(last, m.index));
      const idx = m.slice(1).findIndex((g) => g !== undefined);
      const cls = idx >= 0 && idx < rules.length ? rules[idx][1] : "";
      result.push(<span key={key++} className={cls}>{m[0]}</span>);
      last = m.index! + m[0].length;
    }
    if (last < code.length) result.push(code.slice(last));
    return result;
  };
  return (
    <pre className={cn("dark:bg-[#0d1117] bg-[#f6f8fa] rounded-xl p-4 text-[13px] leading-relaxed overflow-x-auto dark:text-zinc-300 text-zinc-800 border dark:border-zinc-800 border-zinc-200", className)}>
      <code>{tokenize(children.trim())}</code>
    </pre>
  );
}

function CodeBlock({ children, className }: { children: string; className?: string }) {
  return (
    <pre className={cn("dark:bg-[#0d1117] bg-[#f6f8fa] rounded-xl p-4 text-[13px] leading-relaxed overflow-x-auto dark:text-zinc-300 text-zinc-800 border dark:border-zinc-800 border-zinc-200", className)}>
      <code>{children.trim()}</code>
    </pre>
  );
}

// ═══════════════════════════════════════════════════════════════════
// HERO
// ═══════════════════════════════════════════════════════════════════

function Hero() {
  return (
    <section id="hero" className="pt-28 pb-20 text-center">
      <div className="flex items-center justify-center gap-3 mb-6">
        <FootprintIcon className="text-primary" size={40} />
        <BrandName size="lg" />
      </div>
      <h1 className="text-4xl sm:text-5xl md:text-6xl font-extrabold tracking-tight mb-4 leading-[1.1]">
        The flowchart pattern<br /><span className="text-primary">for backend code</span>
      </h1>
      <p className="text-lg text-muted-foreground max-w-2xl mx-auto mb-8">
        Express your business logic as <strong>stages</strong>, <strong>decisions</strong>, and{" "}
        <strong>subflows</strong>. Every read, write, and branch is captured automatically.
        The trace generates itself — no manual logging, never stale.
      </p>
      <div className="flex items-center justify-center gap-3 flex-wrap">
        <a href="#start" className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground font-semibold text-sm hover:brightness-110 transition">
          Get started <ChevronRight className="w-4 h-4" />
        </a>
        <a href="https://github.com/footprintjs/footPrint" target="_blank" rel="noopener"
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border font-semibold text-sm hover:bg-muted transition">
          <Github className="w-4 h-4" /> GitHub
        </a>
      </div>
      <div className="flex items-center justify-center gap-2 flex-wrap mt-6">
        <a href="https://github.com/footprintjs/footPrint/actions"><img src="https://github.com/footprintjs/footPrint/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
        <a href="https://www.npmjs.com/package/footprintjs"><img src="https://img.shields.io/npm/v/footprintjs.svg?style=flat" alt="npm" /></a>
        <a href="https://www.npmjs.com/package/footprintjs"><img src="https://img.shields.io/npm/dm/footprintjs.svg" alt="Downloads" /></a>
        <a href="https://footprintjs.github.io/footprint-playground/samples/llm-agent-tool"><img src="https://img.shields.io/badge/Try_with_LLM-Live_Demo-7c6cf0?style=flat" alt="Try with LLM" /></a>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">MIT · TypeScript · Zero dependencies</p>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════
// PROBLEM SECTION — using REAL footprintjs API
// ═══════════════════════════════════════════════════════════════════

const STEPS = [
  {
    num: 1, title: "You write business logic",
    body: "A pipeline validates an order, checks risk, and routes to the right path. Normal TypedScope code.",
    code: `import { flowChart } from 'footprintjs';

const chart = flowChart<OrderState>('Validate', async (scope) => {
  scope.tier = scope.total > 100 ? 'premium' : 'standard';
}, 'validate')
  .addFunction('Ship', async (scope) => {
    scope.status = 'shipped';
  }, 'ship')
  .build();`,
  },
  {
    num: 2, title: "Decisions are declared, not buried",
    body: "Instead of if/else chains, use decide() with rules as data. The engine evaluates them and records which matched and why.",
    code: `import { decide } from 'footprintjs';

chart.addDeciderFunction('Route', (scope) => {
  return decide(scope, [
    { when: { tier: { eq: 'premium' } },
      then: 'express', label: 'Premium order' },
    { when: { total: { gt: 50 } },
      then: 'priority', label: 'High value' },
  ], 'standard');
}, 'route');`,
  },
  {
    num: 3, title: "The trace writes itself",
    body: "Enable the narrative recorder and run. Every stage, decision, and data operation produces a human-readable trace — zero manual logging.",
    code: `const executor = new FlowChartExecutor(chart);
executor.enableNarrative();
await executor.run({ input: { orderId: 'ORD-42', total: 249 } });

console.log(executor.getNarrative());
// Stage 1: The process began with Validate.
//   Step 1: Write tier = "premium"
// Stage 2: Route — chose express.
//   [Condition]: tier "premium" eq "premium" ✓
// Stage 3: Next, it moved on to ExpressShip.`,
  },
  {
    num: 4, title: "AI reads the trace, not your code",
    body: "The narrative is the contract. An LLM backtracks through the trace to explain decisions — no hallucination, no guessing.",
    code: `// Loan pipeline rejects Bob. User asks: "Why was I rejected?"
//
// The trace shows exactly what happened:
// Stage 1: Write creditScore = 580, dti = 0.6
// Stage 2: Write riskTier = "high", riskFactors = (3 items)
// [Condition]: riskTier "high" eq "high" ✓ → RejectApplication
// Stage 4: Write decision = "REJECTED — below-average credit;
//   DTI exceeds 43%; Self-employed < 2yr"
//
// LLM backtracks: decision ← riskTier ← dti ← monthlyDebts
// Answer comes from the trace, not imagination.`,
  },
  {
    num: 5, title: "One line to expose as an AI tool",
    body: "Any flowchart becomes an MCP tool automatically. The description, input schema, and step list are generated from the graph.",
    code: `// Auto-generate MCP tool from any flowchart
const tool = chart.toMCPTool();
// {
//   name: 'assesscredit',
//   description: '1. AssessCredit 2. EvalRisk 3. Route ...',
//   inputSchema: { type: 'object', properties: { ... } }
// }

// Register with any MCP server or Anthropic SDK:
const anthropicTool = {
  name: tool.name,
  description: tool.description,
  input_schema: tool.inputSchema,
};`,
  },
];

function ProblemSection() {
  return (
    <section className="py-20">
      <SectionTitle id="problem" badge="The Problem" title="Why traces should generate themselves" sub="Manual logging drifts. Structured traces don't." />
      <div className="space-y-16">
        {STEPS.map((s) => (
          <div key={s.num} className="grid md:grid-cols-2 gap-8 items-start">
            <div>
              <div className="flex items-center gap-3 mb-3">
                <span className="w-8 h-8 rounded-full bg-primary/15 text-primary text-sm font-bold flex items-center justify-center">{s.num}</span>
                <h3 className="text-lg font-semibold">{s.title}</h3>
              </div>
              <p className="text-muted-foreground leading-relaxed">{s.body}</p>
            </div>
            <SyntaxBlock>{s.code}</SyntaxBlock>
          </div>
        ))}
      </div>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════
// HOW IT WORKS (interactive recorder demo)
// ═══════════════════════════════════════════════════════════════════

const DEMO_STAGES = [
  { id: "validate", label: "Validate", narrative: 'Stage 1: The process began with Validate.\n  Step 1: Write tier = "premium"' },
  { id: "route", label: "Route (decide)", narrative: '[Condition]: Evaluated Rule 0 "Premium order":\n  tier "premium" eq "premium" ✓\n  → chose express' },
  { id: "express", label: "ExpressShip", narrative: 'Stage 3: Next, it moved on to ExpressShip.\n  Step 1: Write status = "shipped"' },
];

function HowItWorks() {
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const play = useCallback(() => { setActive(0); setPlaying(true); }, []);

  useEffect(() => {
    if (!playing) return;
    if (active < DEMO_STAGES.length - 1) {
      timer.current = setTimeout(() => setActive((a) => a + 1), 1500);
      return () => clearTimeout(timer.current);
    } else { setPlaying(false); }
  }, [playing, active]);

  return (
    <section className="py-20">
      <SectionTitle id="how" badge="Interactive" title="Watch the recorder in action" sub="Click play to step through an order-processing flowchart. The narrative writes itself at each stage." />
      <div className="flex items-center justify-center gap-2 mb-8 flex-wrap">
        {DEMO_STAGES.map((s, i) => (
          <button key={s.id} onClick={() => { setActive(i); setPlaying(false); }}
            className={cn("px-4 py-1.5 rounded-full text-sm font-medium border transition-all",
              i <= active ? "bg-primary text-primary-foreground border-primary" : "dark:border-zinc-700 border-zinc-300 dark:text-zinc-400 text-zinc-500")}>
            {s.label}
          </button>
        ))}
        <button onClick={play} className="ml-4 p-2 rounded-full bg-primary/15 text-primary hover:bg-primary/25 transition" aria-label="Play">
          <Play className="w-4 h-4" />
        </button>
      </div>
      <div className="dark:bg-zinc-900/50 bg-zinc-100 rounded-xl border dark:border-zinc-800 border-zinc-200 p-6 max-w-2xl mx-auto">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-2.5 h-2.5 rounded-full bg-primary animate-pulse" />
          <span className="text-xs font-semibold uppercase tracking-widest dark:text-zinc-400 text-zinc-500">Recorder output</span>
        </div>
        <div className="space-y-3 font-mono text-sm">
          {DEMO_STAGES.slice(0, active + 1).map((s, i) => (
            <div key={s.id} className={cn("transition-opacity duration-500", i <= active ? "opacity-100" : "opacity-0")}>
              {s.narrative.split("\n").map((line, li) => (
                <div key={li} className={cn("py-0.5",
                  line.startsWith("[Condition]") ? "text-primary font-semibold" :
                  line.startsWith("  ") ? "dark:text-zinc-500 text-zinc-400 pl-4" :
                  "dark:text-zinc-300 text-zinc-700")}>
                  {line}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════
// QUICK START — using REAL footprintjs API
// ═══════════════════════════════════════════════════════════════════

function QuickStart() {
  return (
    <section className="py-20">
      <SectionTitle id="start" badge="Quick Start" title="Up and running in 60 seconds" sub="Install, define state, build a chart, run with narrative." />
      <div className="space-y-6 max-w-3xl mx-auto">
        <div>
          <h3 className="text-sm font-semibold mb-2 dark:text-zinc-400 text-zinc-500">1 · Install</h3>
          <CodeBlock>npm install footprintjs</CodeBlock>
        </div>
        <div>
          <h3 className="text-sm font-semibold mb-2 dark:text-zinc-400 text-zinc-500">2 · Build a flowchart with TypedScope</h3>
          <SyntaxBlock>{`import { flowChart, FlowChartExecutor } from 'footprintjs';

interface OrderState {
  orderId: string;
  total: number;
  status?: string;
}

const chart = flowChart<OrderState>('Validate', async (scope) => {
  scope.status = scope.total > 0 ? 'valid' : 'invalid';
}, 'validate')
  .addFunction('Process', async (scope) => {
    scope.status = 'paid';
  }, 'process')
  .build();`}</SyntaxBlock>
        </div>
        <div>
          <h3 className="text-sm font-semibold mb-2 dark:text-zinc-400 text-zinc-500">3 · Run with auto-narrative</h3>
          <SyntaxBlock>{`const executor = new FlowChartExecutor(chart);
executor.enableNarrative();
await executor.run({ input: { orderId: 'ORD-001', total: 49.99 } });

for (const line of executor.getNarrative()) {
  console.log(line);
}
// Stage 1: The process began with Validate.
//   Step 1: Write status = "valid"
// Stage 2: Next, it moved on to Process.
//   Step 1: Write status = "paid"`}</SyntaxBlock>
        </div>
      </div>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════
// GO DEEPER
// ═══════════════════════════════════════════════════════════════════

function GoDeeper() {
  const cards = [
    { icon: <BookOpen className="w-5 h-5" />, title: "Documentation", desc: "Getting started guide, key concepts, and building blocks.", href: "https://footprintjs.github.io/footPrint/getting-started/quick-start/", external: true },
    { icon: <Play className="w-5 h-5" />, title: "Interactive Playground", desc: "Build and run flowcharts in the browser with live narrative.", href: "https://footprintjs.github.io/footprint-playground/", external: true },
    { icon: <Code2 className="w-5 h-5" />, title: "Examples", desc: "31 runnable examples: building blocks, features, flow recorders.", href: "https://github.com/footprintjs/footPrint/tree/main/examples", external: true },
    { icon: <Github className="w-5 h-5" />, title: "GitHub", desc: "Source, issues, discussions, and contribution guide.", href: "https://github.com/footprintjs/footPrint", external: true },
    { icon: <BookOpen className="w-5 h-5" />, title: "API Reference", desc: "Full TypeDoc reference for every class, function, and type.", href: "https://footprintjs.github.io/footPrint/api/", external: true },
    { icon: <Boxes className="w-5 h-5" />, title: "npm", desc: "Install footprintjs. ESM + CommonJS. Zero dependencies.", href: "https://www.npmjs.com/package/footprintjs", external: true },
  ];
  return (
    <section className="py-20">
      <SectionTitle id="explore" badge="Go Deeper" title="Explore the ecosystem" sub="The home page tells the story. These resources have the details." />
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map((c) => (
          <a key={c.title} href={c.href} target={c.external ? "_blank" : undefined} rel={c.external ? "noopener" : undefined}
            className="group block p-5 rounded-xl border bg-card transition-colors hover:border-primary/40">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center text-primary">{c.icon}</div>
              <h3 className="font-semibold group-hover:text-primary transition-colors text-sm flex-1">{c.title}</h3>
              {c.external && <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />}
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">{c.desc}</p>
          </a>
        ))}
      </div>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════
// NAV + FOOTER
// ═══════════════════════════════════════════════════════════════════

function Navbar({ dark, toggle }: { dark: boolean; toggle: () => void }) {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => { const h = () => setScrolled(window.scrollY > 20); window.addEventListener("scroll", h, { passive: true }); return () => window.removeEventListener("scroll", h); }, []);
  return (
    <nav className={cn("fixed top-0 left-0 right-0 z-50 transition-all", scrolled ? "bg-background/80 backdrop-blur-lg border-b shadow-sm" : "bg-transparent")}>
      <div className="max-w-5xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
        <a href="#hero" className="flex items-center gap-2"><FootprintIcon className="text-primary" size={22} /><BrandName size="sm" /></a>
        <div className="hidden md:flex items-center gap-1">
          {NAV_ITEMS.map((item) => (<a key={item.id} href={`#${item.id}`} className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-md">{item.label}</a>))}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={toggle} className="p-2 rounded-md hover:bg-muted transition" aria-label="Toggle theme">
            {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          <a href="https://github.com/footprintjs/footPrint" target="_blank" rel="noopener" className="p-2 rounded-md hover:bg-muted transition hidden sm:block"><Github className="w-4 h-4" /></a>
          <button onClick={() => setOpen(!open)} className="p-2 rounded-md hover:bg-muted transition md:hidden">
            {open ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>
        </div>
      </div>
      {open && (
        <div className="md:hidden border-b bg-background/95 backdrop-blur-lg">
          <div className="px-4 py-3 space-y-1">
            {NAV_ITEMS.map((item) => (<a key={item.id} href={`#${item.id}`} onClick={() => setOpen(false)} className="block px-3 py-2 text-sm text-muted-foreground hover:text-foreground rounded-md">{item.label}</a>))}
          </div>
        </div>
      )}
    </nav>
  );
}

function Footer() {
  return (
    <footer className="border-t py-12 mt-12">
      <div className="max-w-5xl mx-auto px-4 sm:px-6">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-2"><FootprintIcon className="text-primary" size={18} /><span className="text-sm text-muted-foreground"><span className="font-semibold uppercase">FOOTPRINT</span><span className="text-primary font-semibold text-xs">js</span></span></div>
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <a href="https://footprintjs.github.io/footPrint/getting-started/quick-start/" target="_blank" rel="noopener" className="hover:text-foreground transition">Docs</a>
            <a href="https://github.com/footprintjs/footPrint" target="_blank" rel="noopener" className="hover:text-foreground transition">GitHub</a>
            <a href="https://www.npmjs.com/package/footprintjs" target="_blank" rel="noopener" className="hover:text-foreground transition">npm</a>
            <a href="https://footprintjs.github.io/footprint-playground/" target="_blank" rel="noopener" className="hover:text-foreground transition">Playground</a>
            <span>MIT License</span>
          </div>
        </div>
        <div className="mt-6 pt-6 border-t text-center text-xs text-muted-foreground">
          Created by <a href="https://github.com/sanjay1909" target="_blank" rel="noopener" className="font-semibold text-foreground hover:text-primary transition">Sanjay Krishna Anbalagan</a>
        </div>
      </div>
    </footer>
  );
}

// ═══════════════════════════════════════════════════════════════════
// APP
// ═══════════════════════════════════════════════════════════════════

export default function App() {
  const { dark, toggle } = useTheme();
  return (
    <div className="min-h-screen">
      <Navbar dark={dark} toggle={toggle} />
      <main className="max-w-5xl mx-auto px-4 sm:px-6">
        <Hero />
        <hr className="border-border" />
        <ProblemSection />
        <hr className="border-border" />
        <HowItWorks />
        <hr className="border-border" />
        <QuickStart />
        <hr className="border-border" />
        <GoDeeper />
      </main>
      <Footer />
    </div>
  );
}
