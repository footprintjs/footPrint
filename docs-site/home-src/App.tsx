import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import * as Tabs from "@radix-ui/react-tabs";
import * as Slider from "@radix-ui/react-slider";
import * as Accordion from "@radix-ui/react-accordion";
import {
  ChevronRight, ChevronDown, ExternalLink, Sun, Moon, Menu, X,
  GithubIcon, BookOpen, Play, Boxes, Code2,
} from "lucide-react";

// ═══════════════════════════════════════════════════════════════════
// THEME
// ═══════════════════════════════════════════════════════════════════

function useTheme() {
  const [dark, setDark] = useState(() => {
    if (typeof window === "undefined") return true;
    return !document.documentElement.classList.contains("light");
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.classList.toggle("light", !dark);
  }, [dark]);
  return { dark, toggle: useCallback(() => setDark((d) => !d), []) };
}

// ═══════════════════════════════════════════════════════════════════
// SHARED PRIMITIVES
// ═══════════════════════════════════════════════════════════════════

const NAV_ITEMS = [
  { id: "problem", label: "Problem" },
  { id: "how-it-works", label: "How it works" },
  { id: "quickstart", label: "Quick start" },
  { id: "explore", label: "Explore" },
];

function FootprintIcon({ className, size = 24 }: { className?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <ellipse cx="22" cy="10" rx="5" ry="6" strokeWidth="2.5" />
      <ellipse cx="36" cy="6"  rx="4.5" ry="5.5" strokeWidth="2.5" />
      <ellipse cx="47" cy="12" rx="4" ry="5" strokeWidth="2.5" />
      <ellipse cx="53" cy="24" rx="3.5" ry="4.5" strokeWidth="2.5" />
      <path d="M44 34 C44 34, 46 50, 38 56 C30 62, 18 58, 16 50 C14 42, 18 34, 26 32 C34 30, 44 34, 44 34Z" strokeWidth="2.5" />
    </svg>
  );
}

function BrandName({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const cls = { sm: "text-base", md: "text-lg", lg: "text-2xl" }[size];
  return (
    <span className={cn("font-bold tracking-tight", cls)}>
      <span className="uppercase">FOOTPRINT</span>
      <span className="text-primary font-semibold" style={{ fontSize: "0.7em" }}>js</span>
    </span>
  );
}

function SectionTitle({ id, badge, title, sub }: { id: string; badge: string; title: string; sub: string }) {
  return (
    <div id={id} className="text-center mb-12 scroll-mt-20">
      <span className="inline-block text-xs font-semibold tracking-widest uppercase text-primary mb-3">
        {badge}
      </span>
      <h2 className="text-3xl sm:text-4xl font-bold mb-3">{title}</h2>
      <p className="text-muted-foreground max-w-xl mx-auto">{sub}</p>
    </div>
  );
}

// ── Syntax-highlighted code block ──────────────────────────────────

function SyntaxBlock({ children, className }: { children: string; className?: string }) {
  const tokenize = (code: string): ReactNode[] => {
    const rules: [RegExp, string][] = [
      [/\/\/[^\n]*/, "dark:text-zinc-500 text-zinc-400 italic"],
      [/`[^`]*`/, "dark:text-green-300 text-green-700"],
      [/'[^']*'|"[^"]*"/, "dark:text-green-300 text-green-700"],
      [/\b(import|from|export|default|const|let|var|function|async|await|return|if|else|new|type|interface)\b/, "dark:text-purple-400 text-purple-600 font-semibold"],
      [/\b(true|false|null|undefined)\b/, "dark:text-orange-300 text-orange-600"],
      [/\b\d+(\.\d+)?\b/, "dark:text-orange-300 text-orange-600"],
      [/\b(string|number|boolean|void|Record|Promise)\b/, "dark:text-cyan-300 text-cyan-600"],
      [/\b(flowChart|decide|narrative|recorder|run|addDeciderFunction|addFunctionBranch|setDefault|end|build|rules|when|then|otherwise|eq|gt|lt|gte|lte|select|scope|rec|chart|metrics|stage)\b/, "dark:text-blue-300 text-blue-600"],
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

function MiniCode({ children }: { children: string }) {
  return <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{children}</code>;
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
        The flowchart pattern<br />
        <span className="text-primary">for backend code</span>
      </h1>
      <p className="text-lg text-muted-foreground max-w-2xl mx-auto mb-8">
        Express your business logic as <strong>stages</strong>, <strong>decisions</strong>, and{" "}
        <strong>subflows</strong>. Every read, write, and branch is captured automatically.
        The trace generates itself — no manual logging, never stale.
      </p>
      <div className="flex items-center justify-center gap-3 flex-wrap">
        <a href="#problem" className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-primary text-primary-foreground font-semibold hover:opacity-90 transition">
          See Why <ChevronRight className="w-4 h-4" />
        </a>
        <a href="https://github.com/footprintjs/footPrint" target="_blank" rel="noopener"
          className="inline-flex items-center gap-2 px-6 py-3 rounded-lg border font-semibold hover:bg-muted transition">
          <GithubIcon className="w-4 h-4" /> GitHub
        </a>
        <a href="https://footprintjs.github.io/footprint-playground/" target="_blank" rel="noopener"
          className="inline-flex items-center gap-2 px-6 py-3 rounded-lg border font-semibold hover:bg-muted transition">
          <Play className="w-4 h-4" /> Playground
        </a>
        <a href="https://www.npmjs.com/package/footprintjs" target="_blank" rel="noopener"
          className="inline-flex items-center gap-2 px-6 py-3 rounded-lg border font-semibold hover:bg-muted transition">
          <Boxes className="w-4 h-4" /> npm
        </a>
      </div>
      <p className="mt-4 text-xs text-muted-foreground">v4.10.1 · MIT · TypeScript · Zero dependencies</p>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════
// PROBLEM SECTION — 4-tab narrative (The Code → Logs → Cost → Pattern)
// ═══════════════════════════════════════════════════════════════════

const TAB_NAMES = ["The Code", "The Logs Problem", "The Cost Problem", "The Pattern"];

function ProblemSection() {
  const [tab, setTab] = useState("0");

  const nextTab = (label: string) => (
    <button onClick={() => setTab(String(Number(tab) + 1))} className="inline-flex items-center gap-2 text-sm font-semibold text-primary hover:underline">
      {label} <ChevronRight className="w-4 h-4" />
    </button>
  );

  return (
    <section className="py-20">
      <SectionTitle
        id="problem"
        badge="The Problem"
        title="The hidden cost of disconnected logs"
        sub="In LLM-based applications, the biggest cost isn't the tool call — it's the reasoning needed to connect what those tools did."
      />
      <Tabs.Root value={tab} onValueChange={setTab}>
        <Tabs.List className="flex items-center gap-2 mb-10 flex-wrap" aria-label="Problem steps">
          {TAB_NAMES.map((name, i) => (
            <Tabs.Trigger
              key={i}
              value={String(i)}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all border",
                "data-[state=active]:bg-secondary data-[state=active]:text-foreground data-[state=active]:border-border",
                i === 3 && "data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:border-primary/30",
                "data-[state=inactive]:text-muted-foreground data-[state=inactive]:border-transparent data-[state=inactive]:hover:text-foreground",
              )}
            >
              <span className={cn(
                "w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center",
                tab === String(i)
                  ? i === 3 ? "bg-primary text-primary-foreground" : "bg-foreground text-background"
                  : "bg-muted text-muted-foreground",
              )}>
                {i + 1}
              </span>
              {name}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        {/* Tab 1: The Code */}
        <Tabs.Content value="0" className="space-y-6">
          <div className="max-w-2xl">
            <h3 className="text-xl font-bold mb-3">A typical service with branching logic</h3>
            <p className="text-muted-foreground leading-relaxed">
              Here's a pattern every backend engineer recognizes: a service that calls other services based on a condition.
              An order comes in. If the total exceeds a threshold, route to premium fulfillment; otherwise, standard.
              The developer adds <MiniCode>logger.info()</MiniCode> calls to track what happened.
            </p>
          </div>
          <SyntaxBlock>{`async function processOrder(order: Order) {
  logger.info('Processing order ' + order.id);

  const total = calculateTotal(order.items);

  if (total > 1000) {
    logger.info('Routing to premium fulfillment');
    const result = await premiumService.fulfill(order);
    logger.info('Premium result: ' + result.status);
  } else {
    logger.info('Routing to standard fulfillment');
    const result = await standardService.fulfill(order);
    logger.info('Standard complete');
  }

  if (order.requiresNotification) {
    logger.info('Sending notification');
    await notificationService.send(order.customerEmail);
  }

  logger.info('Order processed');
}`}</SyntaxBlock>
          <p className="text-muted-foreground text-sm">This looks fine. Every team writes code like this. But three things go wrong over time...</p>
          {nextTab("See what goes wrong")}
        </Tabs.Content>

        {/* Tab 2: The Logs Problem */}
        <Tabs.Content value="1" className="space-y-8">
          <div className="max-w-2xl">
            <h3 className="text-xl font-bold mb-3">Developer-written logs break in three ways</h3>
          </div>
          <div className="grid lg:grid-cols-3 gap-4">
            <div className="p-5 rounded-xl border border-destructive/20 bg-destructive/5">
              <div className="text-destructive font-semibold text-sm mb-2">1. They go stale</div>
              <p className="text-sm text-muted-foreground leading-relaxed mb-3">
                Last month, someone changed the threshold from 1000 to 500. The log still says "Routing to premium" — but
                the <em>reason</em> it routes there has changed. The log no longer matches the code.
              </p>
              <div className="dark:bg-[#0d1117] bg-[#f6f8fa] rounded-lg p-3 font-mono text-[11px] leading-relaxed">
                <div className="text-zinc-600">{"// Code says: total > 500"}</div>
                <div className="text-zinc-600">{"// Log still says:"}</div>
                <div className="text-amber-400">{"logger.info('Routing to premium')"}</div>
                <div className="text-zinc-600">{"// No actual threshold. No actual total."}</div>
              </div>
            </div>
            <div className="p-5 rounded-xl border border-destructive/20 bg-destructive/5">
              <div className="text-destructive font-semibold text-sm mb-2">2. They're inconsistent</div>
              <p className="text-sm text-muted-foreground leading-relaxed mb-3">
                Premium service logs JSON. Standard service logs a flat string. Notification service logs nothing. Each developer writes logs differently.
              </p>
              <div className="dark:bg-[#0d1117] bg-[#f6f8fa] rounded-lg p-3 font-mono text-[11px] leading-relaxed space-y-1">
                <div className="text-zinc-500">{"// premiumService:"}</div>
                <div className="text-emerald-400">{`{"status":"shipped","carrier":"FedEx"}`}</div>
                <div className="text-zinc-500 mt-2">{"// standardService:"}</div>
                <div className="text-emerald-400">Standard complete</div>
                <div className="text-zinc-500 mt-2">{"// notificationService:"}</div>
                <div className="text-zinc-700 dark:text-zinc-600 italic">...nothing logged...</div>
              </div>
            </div>
            <div className="p-5 rounded-xl border border-destructive/20 bg-destructive/5">
              <div className="text-destructive font-semibold text-sm mb-2">3. They miss decision points</div>
              <p className="text-sm text-muted-foreground leading-relaxed mb-3">
                The log says "Routing to premium" but doesn't say what value was read to make that decision. The total, the threshold, the comparison — none captured.
              </p>
              <div className="dark:bg-[#0d1117] bg-[#f6f8fa] rounded-lg p-3 font-mono text-[11px] leading-relaxed space-y-1">
                <div className="text-emerald-400">[INFO] Routing to premium fulfillment</div>
                <div className="text-zinc-600">{"         ↑ WHY premium?"}</div>
                <div className="text-zinc-600">{"         What was the total?"}</div>
                <div className="text-zinc-600">{"         What was the threshold?"}</div>
              </div>
            </div>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-3">What the logs actually look like:</h4>
            <div className="dark:bg-[#0d1117] bg-[#f6f8fa] rounded-lg p-4 font-mono text-xs leading-loose">
              {[
                { t: "00.012Z", msg: "Processing order ORD-7821" },
                { t: "00.015Z", msg: "Routing to premium fulfillment" },
                { t: "00.847Z", msg: "Premium result: shipped" },
                { t: "00.849Z", msg: "Sending notification" },
                { t: "01.102Z", msg: "Order processed" },
              ].map((e, i) => (
                <div key={i}>
                  <span className="text-zinc-600">14:00:{e.t}</span>{" "}
                  <span className="text-emerald-400 font-semibold">[INFO]</span>{" "}
                  <span className="dark:text-zinc-300 text-zinc-700">{e.msg}</span>
                </div>
              ))}
            </div>
            <p className="text-sm text-muted-foreground mt-3">
              Five log lines. No decision values. No causal connection. Now imagine an LLM needs to answer:{" "}
              <em>"Why was order ORD-7821 routed to premium?"</em>
            </p>
          </div>
          {nextTab("See how this becomes a cost problem")}
        </Tabs.Content>

        {/* Tab 3: The Cost Problem */}
        <Tabs.Content value="2" className="space-y-8">
          <div className="max-w-2xl">
            <h3 className="text-xl font-bold mb-3">The LLM has to reason across disconnected logs</h3>
            <p className="text-muted-foreground leading-relaxed">
              When a user asks a follow-up — or when you need to debug — the LLM retrieves scattered logs and spends reasoning tokens connecting them into a causal chain.
            </p>
          </div>
          <div className="dark:bg-[#0d1117] bg-[#f6f8fa] rounded-xl p-6 border dark:border-zinc-800 border-zinc-200">
            <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-4">
              User asks: "Why was order ORD-7821 routed to premium?"
            </div>
            <div className="space-y-3">
              {[
                { action: "Tool call", detail: "Retrieve order logs for ORD-7821", tokens: 180, reasoning: false },
                { action: "Reasoning", detail: 'Log says "Routing to premium" but no reason. Need more context.', tokens: 320, reasoning: true },
                { action: "Tool call", detail: "Fetch order details — get total amount", tokens: 210, reasoning: false },
                { action: "Tool call", detail: "Fetch service config — get routing threshold", tokens: 190, reasoning: false },
                { action: "Reasoning", detail: "Order total is $1,250. Config says threshold is 500 (was 1000). So total > 500 → premium.", tokens: 580, reasoning: true },
                { action: "Reasoning", detail: "But was the threshold 1000 or 500 when this ran? Log doesn't say. Check deploy history...", tokens: 440, reasoning: true },
                { action: "Tool call", detail: "Check deployment timestamps around order time", tokens: 200, reasoning: false },
                { action: "Reasoning", detail: "Deployment was after. Threshold was 1000. Total $1,250 > $1,000 → premium.", tokens: 380, reasoning: true },
              ].map((e, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className={cn("shrink-0 w-20 text-[10px] font-semibold uppercase tracking-wide pt-0.5", e.reasoning ? "text-red-400" : "text-amber-400")}>
                    {e.action}
                  </div>
                  <div className="flex-1 dark:text-zinc-400 text-zinc-600 text-xs leading-relaxed">{e.detail}</div>
                  <span className={cn("shrink-0 text-xs font-mono", e.reasoning ? "text-red-400" : "text-zinc-600")}>~{e.tokens}</span>
                </div>
              ))}
              <div className="border-t dark:border-zinc-800 border-zinc-200 pt-3 mt-3 flex items-center justify-between">
                <span className="text-xs font-semibold text-red-400">4 tool calls + 4 reasoning steps</span>
                <div className="text-right">
                  <div className="text-sm font-mono font-bold text-red-400">~2,500 tokens</div>
                  <div className="text-[10px] text-zinc-600">Requires expensive reasoning model</div>
                </div>
              </div>
            </div>
          </div>
          <div className="p-5 rounded-xl border border-amber-500/20 bg-amber-500/5">
            <p className="text-sm leading-relaxed">
              <span className="font-semibold text-foreground">The core issue:</span>{" "}
              <span className="text-muted-foreground">
                The LLM needs a high-end reasoning model to reconstruct what the code decided and why.
                It's not the tool call that's expensive — it's the chain-of-thought to connect disconnected, potentially stale logs.
                This cost scales with every follow-up question, every debug session, every audit.
              </span>
            </p>
          </div>
          {nextTab("See how the Flowchart Pattern solves this")}
        </Tabs.Content>

        {/* Tab 4: The Pattern */}
        <Tabs.Content value="3" className="space-y-8">
          <div className="max-w-2xl">
            <h3 className="text-xl font-bold mb-3">The log and the code become the same thing</h3>
            <p className="text-muted-foreground leading-relaxed">
              In the Flowchart Pattern, every read, write, and decision is captured automatically from execution.
              The trace can never go stale — it's what <em>actually happened</em>, not what a developer remembered to log.
            </p>
          </div>

          <div className="grid lg:grid-cols-2 gap-6">
            <div>
              <div className="text-xs font-semibold text-primary uppercase tracking-wide mb-2">Same logic, as a flowchart</div>
              <SyntaxBlock>{`import { flowChart, narrative, rules, gt } from 'footprintjs';

const processOrder = flowChart<OrderState>()
  .stage('read-order', async (state) => {
    state.total = calculateTotal(state.order.items);
    state.threshold = 500;
  })
  .decide('route', rules()
    .when('total', gt('threshold')).then('premium')
    .default('standard')
  )
  .stage('premium', async (state) => {
    state.result = await premiumService.fulfill(state.order);
  })
  .stage('standard', async (state) => {
    state.result = await standardService.fulfill(state.order);
  })
  .stage('notify', async (state) => {
    if (state.order.requiresNotification) {
      await notificationService.send(state.order.customerEmail);
    }
  })
  .recorder(narrative())
  .build();`}</SyntaxBlock>
            </div>
            <div>
              <div className="text-xs font-semibold text-emerald-400 uppercase tracking-wide mb-2">Auto-generated trace (zero logger.info)</div>
              <div className="dark:bg-[#0d1117] bg-[#f6f8fa] rounded-lg p-4 font-mono text-xs leading-loose min-h-[280px]">
                <div className="dark:text-zinc-300 text-zinc-700">Stage 1: The process began with <span className="text-blue-500 dark:text-blue-400">read-order</span>.</div>
                <div className="dark:text-zinc-500 text-zinc-500 pl-4">{"Read order = { id: \"ORD-7821\", items: [...] }"}</div>
                <div className="dark:text-zinc-500 text-zinc-500 pl-4">Write total = <span className="text-primary">1250</span></div>
                <div className="dark:text-zinc-500 text-zinc-500 pl-4">Write threshold = <span className="text-primary">500</span></div>
                <div className="dark:text-zinc-300 text-zinc-700 mt-2">Stage 2: <span className="text-blue-500 dark:text-blue-400">route</span>.</div>
                <div className="dark:text-zinc-500 text-zinc-500 pl-4">Read total = <span className="text-primary">1250</span></div>
                <div className="dark:text-zinc-500 text-zinc-500 pl-4">Read threshold = <span className="text-primary">500</span></div>
                <div className="text-purple-500 dark:text-purple-400 pl-4">[Condition]: total (1250) &gt; threshold (500) ✓, chose <span className="text-primary">premium</span>.</div>
                <div className="dark:text-zinc-300 text-zinc-700 mt-2">Stage 3: <span className="text-blue-500 dark:text-blue-400">premium</span>.</div>
                <div className="dark:text-zinc-500 text-zinc-500 pl-4">{"Read order = { id: \"ORD-7821\" }"}</div>
                <div className="dark:text-zinc-500 text-zinc-500 pl-4">{"Write result = { status: \"shipped\", carrier: \"FedEx\" }"}</div>
                <div className="dark:text-zinc-300 text-zinc-700 mt-2">Stage 4: <span className="text-blue-500 dark:text-blue-400">notify</span>.</div>
                <div className="dark:text-zinc-500 text-zinc-500 pl-4">Read order.requiresNotification = true</div>
              </div>
              <div className="mt-3 text-xs text-muted-foreground">Every decision value. Every read. Every write. Never stale.</div>
            </div>
          </div>

          {/* Comparison */}
          <div className="dark:bg-[#0d1117] bg-[#f6f8fa] rounded-xl p-6 border dark:border-zinc-800 border-zinc-200">
            <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-4">
              Same question: "Why was order ORD-7821 routed to premium?"
            </div>
            <div className="grid lg:grid-cols-2 gap-6">
              <div className="p-4 rounded-lg border border-red-500/20 bg-red-500/5">
                <div className="text-xs font-semibold text-red-400 uppercase tracking-wide mb-3">Without the pattern</div>
                <div className="space-y-2 text-xs dark:text-zinc-400 text-zinc-600">
                  <div className="flex justify-between"><span>4 tool calls to retrieve logs</span><span className="dark:text-zinc-600 text-zinc-500">780 tokens</span></div>
                  <div className="flex justify-between"><span>4 reasoning steps to connect them</span><span className="text-red-400">1,720 tokens</span></div>
                  <div><span>May still be wrong (stale logs)</span></div>
                </div>
                <div className="border-t dark:border-zinc-800 border-zinc-200 mt-3 pt-3 flex justify-between items-baseline">
                  <span className="text-xs text-zinc-500">Total</span>
                  <div className="text-right">
                    <div className="text-lg font-mono font-bold text-red-400">~2,500 tokens</div>
                    <div className="text-[10px] text-zinc-600">Needs expensive reasoning model</div>
                  </div>
                </div>
              </div>
              <div className="p-4 rounded-lg border border-emerald-500/20 bg-emerald-500/5">
                <div className="text-xs font-semibold text-emerald-400 uppercase tracking-wide mb-3">With the Flowchart Pattern</div>
                <div className="space-y-2 text-xs dark:text-zinc-400 text-zinc-600">
                  <div className="flex justify-between"><span>Read the auto-generated narrative</span><span className="text-emerald-500 dark:text-emerald-400">~200 tokens</span></div>
                  <div><span>Answer is already in the trace</span></div>
                  <div><span>Can never be stale or wrong</span></div>
                </div>
                <div className="border-t dark:border-zinc-800 border-zinc-200 mt-3 pt-3 flex justify-between items-baseline">
                  <span className="text-xs text-zinc-500">Total</span>
                  <div className="text-right">
                    <div className="text-lg font-mono font-bold text-emerald-400">~200 tokens</div>
                    <div className="text-[10px] text-zinc-600">Any lightweight model works</div>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-6 p-4 rounded-lg border border-primary/30 bg-primary/5">
              <p className="text-sm leading-relaxed">
                <span className="font-bold text-primary">The real unlock:</span>{" "}
                <span className="text-muted-foreground">
                  When the causal chain is already in the trace, application designers can choose a smaller, cheaper model at runtime.
                  The pattern spoon-feeds the reasoning context — so you pick the right model tier for the job, not the most expensive one.
                </span>
              </p>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-3">
              <div className="text-center p-3 rounded-lg dark:bg-zinc-800/50 bg-zinc-100">
                <div className="text-[10px] text-zinc-500 uppercase tracking-wide mb-1">Without pattern</div>
                <div className="text-sm font-mono font-semibold text-red-400">Large reasoning model</div>
                <div className="text-[10px] text-zinc-600 mt-1">$15 / 1M input tokens</div>
              </div>
              <div className="text-center p-3 flex items-center justify-center">
                <ChevronRight className="w-5 h-5 text-primary" />
              </div>
              <div className="text-center p-3 rounded-lg dark:bg-zinc-800/50 bg-zinc-100">
                <div className="text-[10px] text-zinc-500 uppercase tracking-wide mb-1">With pattern</div>
                <div className="text-sm font-mono font-semibold text-emerald-400">Any lightweight model</div>
                <div className="text-[10px] text-zinc-600 mt-1">$0.25 / 1M input tokens</div>
              </div>
            </div>
          </div>
        </Tabs.Content>
      </Tabs.Root>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════
// HOW IT WORKS — Execution timeline with Radix Slider
// ═══════════════════════════════════════════════════════════════════

const TIMELINE_STAGES = [
  { name: "read-order", type: "stage" as const, ms: 12, reads: 1, writes: 2 },
  { name: "route", type: "decision" as const, ms: 1, reads: 2, writes: 0 },
  { name: "premium", type: "service" as const, ms: 832, reads: 1, writes: 1 },
  { name: "notify", type: "service" as const, ms: 253, reads: 1, writes: 0 },
];
const TOTAL_MS = TIMELINE_STAGES.reduce((s, e) => s + e.ms, 0);

function HowItWorks() {
  const [active, setActive] = useState(TIMELINE_STAGES.length - 1);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval>>();

  const play = useCallback(() => {
    setActive(0);
    setPlaying(true);
  }, []);

  useEffect(() => {
    if (playing) {
      timer.current = setInterval(() => {
        setActive((e) => {
          if (e >= TIMELINE_STAGES.length - 1) { setPlaying(false); return TIMELINE_STAGES.length - 1; }
          return e + 1;
        });
      }, 500);
      return () => clearInterval(timer.current);
    }
  }, [playing]);

  const visible = TIMELINE_STAGES.slice(0, active + 1);
  const current = TIMELINE_STAGES[active];
  const durationSoFar = visible.reduce((s, e) => s + e.ms, 0);
  const readsSoFar = visible.reduce((s, e) => s + e.reads, 0);
  const writesSoFar = visible.reduce((s, e) => s + e.writes, 0);

  const barColor = (type: string) =>
    type === "decision" ? "bg-purple-500" : type === "service" ? "bg-blue-500" : "bg-zinc-400 dark:bg-zinc-500";

  return (
    <section className="py-20">
      <SectionTitle
        id="how-it-works"
        badge="How It Works"
        title="Recorders observe. You query."
        sub="Data is collected automatically during the single execution pass. Drag the slider to scrub through what happened."
      />

      <div className="dark:bg-[#0d1117] bg-[#f6f8fa] rounded-xl p-6 border dark:border-zinc-800 border-zinc-200">
        <div className="flex items-center justify-between mb-4">
          <h3 className="dark:text-white text-zinc-900 font-semibold text-sm">Execution Timeline</h3>
          <button onClick={play} className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-primary/20 text-primary text-xs font-semibold hover:bg-primary/30 transition">
            <Play className="w-3 h-3" /> {playing ? "Playing..." : "Replay"}
          </button>
        </div>

        {/* Colored bars */}
        <div className="flex gap-1 mb-3">
          {TIMELINE_STAGES.map((s, i) => (
            <button
              key={i}
              onClick={() => { setActive(i); setPlaying(false); }}
              className={cn(
                "h-8 rounded transition-all text-[10px] font-semibold flex items-center justify-center overflow-hidden whitespace-nowrap",
                i <= active ? cn(barColor(s.type), "text-white") : "dark:bg-zinc-800/50 bg-zinc-200 dark:text-zinc-600 text-zinc-400",
                i === active && "ring-2 ring-primary",
              )}
              style={{ flex: Math.max(s.ms / TOTAL_MS, 0.06) }}
              title={`${s.name} (${s.ms}ms)`}
            >
              {s.ms > 100 ? s.name : ""}
            </button>
          ))}
        </div>

        {/* Radix Slider */}
        <div className="flex items-center gap-3 mb-6">
          <Slider.Root
            value={[active]}
            onValueChange={([v]) => { setActive(v); setPlaying(false); }}
            max={TIMELINE_STAGES.length - 1}
            step={1}
            className="relative flex items-center flex-1 h-6 touch-none select-none"
            aria-label="Timeline position"
          >
            <Slider.Track className="relative h-1.5 w-full rounded-full dark:bg-zinc-800 bg-zinc-200">
              <Slider.Range className="absolute h-full rounded-full bg-primary" />
            </Slider.Track>
            <Slider.Thumb className="block w-5 h-5 rounded-full bg-primary shadow-[0_0_0_3px] shadow-primary/25 hover:shadow-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 transition-shadow cursor-grab active:cursor-grabbing" />
          </Slider.Root>
          <span className="font-mono text-xs text-primary whitespace-nowrap">{current.name}</span>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          <div className="dark:bg-zinc-800/50 bg-zinc-100 rounded-lg p-3">
            <div className="text-[10px] text-zinc-500 mb-1">Steps completed</div>
            <div className="text-lg font-bold font-mono text-emerald-500 dark:text-emerald-400">{visible.length} / {TIMELINE_STAGES.length}</div>
          </div>
          <div className="dark:bg-zinc-800/50 bg-zinc-100 rounded-lg p-3">
            <div className="text-[10px] text-zinc-500 mb-1">Duration so far</div>
            <div className="text-lg font-bold font-mono text-blue-500 dark:text-blue-400">{durationSoFar}ms</div>
            <div className="text-[10px] dark:text-zinc-600 text-zinc-500">{(durationSoFar / TOTAL_MS * 100).toFixed(0)}% of total</div>
          </div>
          <div className="dark:bg-zinc-800/50 bg-zinc-100 rounded-lg p-3">
            <div className="text-[10px] text-zinc-500 mb-1">Reads so far</div>
            <div className="text-lg font-bold font-mono text-cyan-500 dark:text-cyan-400">{readsSoFar}</div>
          </div>
          <div className="dark:bg-zinc-800/50 bg-zinc-100 rounded-lg p-3">
            <div className="text-[10px] text-zinc-500 mb-1">Writes so far</div>
            <div className="text-lg font-bold font-mono text-amber-500 dark:text-amber-400">{writesSoFar}</div>
          </div>
        </div>

        {/* Narrative output */}
        <div className="dark:bg-zinc-900/50 bg-white rounded-lg p-4 font-mono text-xs leading-loose border dark:border-zinc-800 border-zinc-200">
          {visible.map((s, i) => {
            const intro = i === 0 ? "The process began with" : "Next, it moved on to";
            return (
              <div key={i} className={cn("transition-colors", i === active ? "text-primary" : "dark:text-zinc-400 text-zinc-600")}>
                Stage {i + 1}: {intro} {s.name}.
                {s.type === "decision" && (
                  <span className="text-purple-500 dark:text-purple-400"> [Condition]: total (1250) &gt; threshold (500), chose premium.</span>
                )}
                {s.type === "service" && (
                  <span className="text-blue-500 dark:text-blue-400"> ({s.ms}ms)</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <p className="text-sm text-muted-foreground mt-6 max-w-2xl">
        This is the recorder system in action. Attach a recorder, run your flowchart, and the data collects itself.
        The slider shows progressive accumulation — the same mechanism that lets an LLM read exactly what happened up to any point.
      </p>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════
// QUICK START — Radix Accordion
// ═══════════════════════════════════════════════════════════════════

function AccordionTrigger({ children, step }: { children: ReactNode; step: string }) {
  return (
    <Accordion.Header className="flex">
      <Accordion.Trigger className={cn(
        "group flex items-center justify-between w-full px-5 py-3.5 text-left font-semibold text-sm",
        "rounded-t-xl data-[state=closed]:rounded-b-xl",
        "dark:bg-zinc-900/70 bg-white border dark:border-zinc-800 border-zinc-200",
        "hover:bg-muted/50 transition-colors",
      )}>
        <div className="flex items-center gap-3">
          <span className="w-6 h-6 rounded-full bg-primary/15 text-primary text-xs font-bold flex items-center justify-center">
            {step}
          </span>
          {children}
        </div>
        <ChevronDown className="w-4 h-4 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
      </Accordion.Trigger>
    </Accordion.Header>
  );
}

function AccordionContent({ children }: { children: ReactNode }) {
  return (
    <Accordion.Content className="overflow-hidden data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-1">
      <div className="px-5 pb-5 pt-3 border-x border-b dark:border-zinc-800 border-zinc-200 rounded-b-xl dark:bg-zinc-900/30 bg-zinc-50/50">
        {children}
      </div>
    </Accordion.Content>
  );
}

function QuickStart() {
  return (
    <section className="py-20">
      <SectionTitle
        id="quickstart"
        badge="Quick Start"
        title="Up and running in 60 seconds"
        sub="Install, build a chart, attach a recorder, run it."
      />
      <Accordion.Root type="single" defaultValue="step-2" collapsible className="max-w-3xl mx-auto space-y-3">
        <Accordion.Item value="step-1">
          <AccordionTrigger step="1">Install</AccordionTrigger>
          <AccordionContent>
            <CodeBlock>npm install footprintjs</CodeBlock>
          </AccordionContent>
        </Accordion.Item>
        <Accordion.Item value="step-2">
          <AccordionTrigger step="2">Build and run</AccordionTrigger>
          <AccordionContent>
            <SyntaxBlock>{`import { flowChart, narrative, metrics } from 'footprintjs';

const chart = flowChart<{ input: string; output: string }>()
  .stage('process', async (state) => {
    state.output = state.input.toUpperCase();
  })
  .recorder(narrative())
  .recorder(metrics())
  .build();

const result = await chart.run({ input: 'hello world', output: '' });

result.recorder('narrative').lines();
// → ["Stage 1: The process began with process.",
//    "  Read input = \\"hello world\\"",
//    "  Write output = \\"HELLO WORLD\\""]`}</SyntaxBlock>
            <div className="mt-4 p-4 rounded-lg border bg-card">
              <p className="text-sm text-muted-foreground leading-relaxed">
                No collector, no backend, no configuration. The recorder observes the execution and the data is available the moment <MiniCode>run()</MiniCode> returns.
              </p>
            </div>
          </AccordionContent>
        </Accordion.Item>
      </Accordion.Root>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════
// GO DEEPER (navigation cards)
// ═══════════════════════════════════════════════════════════════════

function GoDeeper() {
  const cards = [
    { icon: <BookOpen className="w-5 h-5" />, title: "API Documentation", desc: "Full reference for stages, decisions, loops, subflows, recorders, and the rules DSL.", href: "https://footprintjs.github.io/footPrint/api/", external: true },
    { icon: <Play className="w-5 h-5" />, title: "Playground", desc: "Interactive browser-based environment. Build flowcharts, run them, watch narrative update in real time.", href: "https://footprintjs.github.io/footprint-playground/", external: true },
    { icon: <Code2 className="w-5 h-5" />, title: "Samples", desc: "Working examples: order processing, service orchestration, rule-based routing, pause/resume, and custom recorders.", href: "https://github.com/footprintjs/footPrint/tree/main/samples", external: true },
    { icon: <GithubIcon className="w-5 h-5" />, title: "GitHub", desc: "Source code, issues, and releases. MIT licensed. Contributions welcome.", href: "https://github.com/footprintjs/footPrint", external: true },
    { icon: <Boxes className="w-5 h-5" />, title: "npm", desc: "Install footprintjs from the npm registry. Published with ESM and CommonJS support.", href: "https://www.npmjs.com/package/footprintjs", external: true },
  ];

  return (
    <section className="py-20">
      <SectionTitle
        id="explore"
        badge="Go Deeper"
        title="Explore the ecosystem"
        sub="The home page tells the story. These resources have the details."
      />
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map((c) => (
          <a key={c.title} href={c.href} target="_blank" rel="noopener" className="group block p-5 rounded-xl border bg-card transition-colors hover:border-primary/40">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center text-primary">{c.icon}</div>
              <div className="flex-1"><h3 className="font-semibold group-hover:text-primary transition-colors text-sm">{c.title}</h3></div>
              <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
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
  useEffect(() => {
    const h = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", h, { passive: true });
    return () => window.removeEventListener("scroll", h);
  }, []);

  return (
    <nav className={cn(
      "fixed top-0 left-0 right-0 z-50 transition-all",
      scrolled ? "bg-background/80 backdrop-blur-lg border-b shadow-sm" : "bg-transparent"
    )}>
      <div className="max-w-5xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
        <a href="#hero" className="flex items-center gap-2">
          <FootprintIcon className="text-primary" size={22} />
          <BrandName size="sm" />
        </a>
        <div className="hidden md:flex items-center gap-1">
          {NAV_ITEMS.map((item) => (
            <a key={item.id} href={`#${item.id}`} className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-md">
              {item.label}
            </a>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={toggle} className="p-2 rounded-md hover:bg-muted transition" aria-label="Toggle theme">
            {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          <a href="https://github.com/footprintjs/footPrint" target="_blank" rel="noopener" className="p-2 rounded-md hover:bg-muted transition hidden sm:block">
            <GithubIcon className="w-4 h-4" />
          </a>
          <button onClick={() => setOpen(!open)} className="p-2 rounded-md hover:bg-muted transition md:hidden">
            {open ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>
        </div>
      </div>
      {open && (
        <div className="md:hidden border-b bg-background/95 backdrop-blur-lg">
          <div className="px-4 py-3 space-y-1">
            {NAV_ITEMS.map((item) => (
              <a key={item.id} href={`#${item.id}`} onClick={() => setOpen(false)} className="block px-3 py-2 text-sm text-muted-foreground hover:text-foreground rounded-md">
                {item.label}
              </a>
            ))}
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
          <div className="flex items-center gap-2">
            <FootprintIcon className="text-primary" size={18} />
            <span className="text-sm text-muted-foreground">
              <span className="font-semibold uppercase">FOOTPRINT</span><span className="text-primary font-semibold text-xs">js</span>{" "}v4.10.1
            </span>
          </div>
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <a href="https://footprintjs.github.io/footPrint/api/" target="_blank" rel="noopener" className="hover:text-foreground transition">API Docs</a>
            <a href="https://github.com/footprintjs/footPrint" target="_blank" rel="noopener" className="hover:text-foreground transition">GitHub</a>
            <a href="https://www.npmjs.com/package/footprintjs" target="_blank" rel="noopener" className="hover:text-foreground transition">npm</a>
            <a href="https://footprintjs.github.io/footprint-playground/" target="_blank" rel="noopener" className="hover:text-foreground transition">Playground</a>
            <span>MIT License</span>
          </div>
        </div>
        <div className="mt-6 pt-6 border-t text-center text-xs text-muted-foreground">
          Created by{" "}
          <a href="https://github.com/sanjay1909" target="_blank" rel="noopener" className="font-semibold text-foreground hover:text-primary transition">
            Sanjay Krishna Anbalagan
          </a>
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
