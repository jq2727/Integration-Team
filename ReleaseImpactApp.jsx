import { useState, useRef, useEffect, useCallback } from "react";

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert release integration analyst for the Hi Marley platform. You help analyze Jira tickets for the HMB project and produce integration impact analysis documents.

You have access to Atlassian Jira via MCP tools. Use them to search for tickets in the HMB project.

When analyzing tickets, classify integration impacts from the perspective of external consumers of the Public Hi Marley API and Webhooks across these dimensions:
- New API Endpoints, Modified API Endpoints, Breaking API Changes
- New Webhook Events, Modified Webhook Payloads, Webhook Behavioral Changes
- Authentication Changes, Authorization Changes, Security Fixes, Transport & Protocol Changes
- Data Migrations, Process/Workflow Changes

Risk levels: Critical, High, Medium, Low, None

Always be thorough, structured, and precise. Format responses with clear sections and tables where appropriate. When generating document content, produce well-organized markdown that can be rendered cleanly.`;

// ─── PROMPT TEMPLATES ─────────────────────────────────────────────────────────
const PROMPTS = {
  runAnalysis: {
    id: "runAnalysis",
    label: "Run Impact Analysis",
    icon: "⚡",
    color: "#f59e0b",
    description: "Pull all release tickets from Jira and generate full integration impact analysis",
    initialMessage: "I need to run a full impact analysis. Before I start, I need two things:\n\n1. **Which release version** should I analyze? (e.g., 2.83, 2.84)\n2. **How many tickets** are expected in this release?\n\nPlease provide both answers and I'll begin pulling tickets from Jira.",
    buildPrompt: (version, ticketCount) => `Run a complete integration impact analysis for Release ${version}. Expected ticket count: ${ticketCount}.

Search the HMB Jira project for all tickets in release version ${version}. Work through them in batches of 5, analyzing each ticket for integration impacts across all 12 dimensions (New API Endpoints, Modified API Endpoints, Breaking API Changes, New Webhook Events, Modified Webhook Payloads, Webhook Behavioral Changes, Authentication Changes, Authorization Changes, Security Fixes, Transport & Protocol Changes, Data Migrations, Process/Workflow Changes).

Assign risk levels (Critical/High/Medium/Low/None) and produce:
1. A complete per-ticket breakdown table
2. An executive summary with risk distribution, critical items, and partner communication checklist
3. Integration test cases for all Medium+ risk tickets

Start by searching Jira for tickets in release ${version} and report back the total count found before proceeding with analysis.`
  },
  resumeAnalysis: {
    id: "resumeAnalysis",
    label: "Resume Impact Analysis",
    icon: "▶",
    color: "#10b981",
    description: "Continue a previously started analysis from a specific ticket",
    initialMessage: "To resume the analysis, I need three things:\n\n1. **Which release version** were you analyzing?\n2. **Which ticket number** should we resume from?\n3. **Do you have partial output files** saved in the project folder?\n\nPlease provide all three and I'll pick up right where you left off.",
    buildPrompt: (version, startTicket) => `Resume the integration impact analysis for Release ${version}, starting from ticket ${startTicket}. Continue using the exact same methodology, dimensions, and risk level classifications. Search Jira for remaining tickets in release ${version} and begin from ${startTicket}. Merge results with previously completed analysis and maintain cumulative progress.`
  },
  partnerNotice: {
    id: "partnerNotice",
    label: "Partner Change Notice",
    icon: "📋",
    color: "#6366f1",
    description: "Generate a partner-facing communication document for all required actions",
    initialMessage: "To generate the Partner Change Notice, I need:\n\n1. **Which release version** is this for?\n2. **Is the Executive Impact Summary already generated** for this release? (If not, I'd suggest running 'Run Impact Analysis' first.)\n\nPlease confirm and I'll extract all partner-facing action items and draft the communication.",
    buildPrompt: (version) => `Generate a Partner Change Notice for Release ${version}. Extract every item where Partner Action is required from the impact analysis. Group by urgency: IMMEDIATE, Before Release, At Release, Post-Release. For each item, write a partner-facing description (plain language) covering: what changed, what the partner must do, by when, and consequences of inaction. Format as a professional communication document ready to send to integration partners. Include a quick-reference table at the end.`
  },
  authBrief: {
    id: "authBrief",
    label: "Auth & Security Brief",
    icon: "🔐",
    color: "#ef4444",
    description: "Deep-dive security analysis of all auth, OAuth2, mTLS, and token changes",
    initialMessage: "To generate the Auth & Security Brief, I need:\n\n1. **Which release version** is this for?\n2. **Is the Per-Ticket Breakdown already generated?** (If not, run 'Run Impact Analysis' first.)\n\nOnce confirmed, I'll pull all auth/security tickets and produce a severity-ranked brief with testing steps.",
    buildPrompt: (version) => `Generate an Auth & Security Brief for Release ${version}. Search Jira for all HMB tickets in this release that involve: OAuth2, authentication, authorization, mTLS, API gateway, token handling, secret rotation, or security vulnerabilities. For each ticket provide: vulnerability/change description, attack vector or risk scenario, specific testing steps, and partner-side actions. Rank by severity (Critical first). Include a pre-release sign-off checklist.`
  },
  testProgress: {
    id: "testProgress",
    label: "Test Progress Update",
    icon: "✅",
    color: "#14b8a6",
    description: "Review the Integration Test Checklist and generate a go/no-go status report",
    initialMessage: "To generate a Test Progress Update, I need:\n\n1. **Which release version** is this for?\n\nOnce you confirm, I'll read the Integration Test Checklist and calculate a complete status report with go/no-go recommendation.",
    buildPrompt: (version) => `Generate a Test Progress Update for Release ${version}. Review the integration test checklist and calculate: total tests vs passed vs failed vs not yet run; breakdown by Priority (P1/P2/P3); breakdown by Test Type; breakdown by Pre-Release vs Post-Release. Flag any P1 tests still failing or not run. Provide a go/no-go recommendation (all P1 must pass, no Critical tickets with failing tests, all auth/security tests must be run).`
  }
};

// ─── API CALL ─────────────────────────────────────────────────────────────────
async function callClaude(messages, onChunk) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages,
      mcp_servers: [{ type: "url", url: "https://mcp.atlassian.com/v1/mcp", name: "atlassian-mcp" }]
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message || `API error ${response.status}`);
  }

  const data = await response.json();
  const textBlocks = data.content?.filter(b => b.type === "text").map(b => b.text).join("\n") || "";
  const toolBlocks = data.content?.filter(b => b.type === "mcp_tool_use") || [];
  const toolResults = data.content?.filter(b => b.type === "mcp_tool_result") || [];

  return { text: textBlocks, toolCalls: toolBlocks, toolResults, raw: data };
}

// ─── MARKDOWN RENDERER ────────────────────────────────────────────────────────
function renderMarkdown(text) {
  if (!text) return "";
  return text
    .replace(/^### (.+)$/gm, '<h3 class="md-h3">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="md-h2">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="md-h1">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code class="md-code">$1</code>')
    .replace(/^\| (.+) \|$/gm, (_, row) => {
      const cells = row.split(" | ").map(c => `<td>${c.trim()}</td>`).join("");
      return `<tr>${cells}</tr>`;
    })
    .replace(/(<tr>.*<\/tr>\n?)+/gs, m => `<table class="md-table"><tbody>${m}</tbody></table>`)
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/gs, m => `<ul class="md-ul">${m}</ul>`)
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    .replace(/\n\n/g, '</p><p class="md-p">')
    .replace(/^(?!<[htulipc])(.+)$/gm, '<p class="md-p">$1</p>');
}

// ─── MESSAGE BUBBLE ───────────────────────────────────────────────────────────
function MessageBubble({ msg }) {
  const isUser = msg.role === "user";
  const isSystem = msg.role === "system";

  if (isSystem) {
    return (
      <div style={{ display: "flex", justifyContent: "center", margin: "8px 0" }}>
        <div style={{
          background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 6, padding: "6px 14px", fontSize: 12, color: "#94a3b8", fontFamily: "monospace"
        }}>
          {msg.content}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", marginBottom: 16 }}>
      {!isUser && (
        <div style={{
          width: 32, height: 32, borderRadius: "50%", background: "linear-gradient(135deg,#f59e0b,#ef4444)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 14, marginRight: 10, flexShrink: 0, marginTop: 2
        }}>⚡</div>
      )}
      <div style={{
        maxWidth: "78%",
        background: isUser ? "linear-gradient(135deg,#1e3a5f,#1e40af)" : "rgba(255,255,255,0.05)",
        border: isUser ? "1px solid #3b82f6" : "1px solid rgba(255,255,255,0.1)",
        borderRadius: isUser ? "18px 18px 4px 18px" : "4px 18px 18px 18px",
        padding: "12px 16px", color: "#e2e8f0", fontSize: 14, lineHeight: 1.6
      }}>
        {isUser ? (
          <span style={{ whiteSpace: "pre-wrap" }}>{msg.content}</span>
        ) : (
          <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
        )}
      </div>
    </div>
  );
}

// ─── INPUT MODAL ──────────────────────────────────────────────────────────────
function InputModal({ prompt, onSubmit, onClose }) {
  const [v1, setV1] = useState("");
  const [v2, setV2] = useState("");

  const fields = {
    runAnalysis: [
      { key: "version", label: "Release Version", placeholder: "e.g. 2.83", val: v1, set: setV1 },
      { key: "tickets", label: "Expected Ticket Count", placeholder: "e.g. 78", val: v2, set: setV2 }
    ],
    resumeAnalysis: [
      { key: "version", label: "Release Version", placeholder: "e.g. 2.83", val: v1, set: setV1 },
      { key: "startTicket", label: "Resume From Ticket", placeholder: "e.g. HMB-15050", val: v2, set: setV2 }
    ],
    partnerNotice: [
      { key: "version", label: "Release Version", placeholder: "e.g. 2.83", val: v1, set: setV1 }
    ],
    authBrief: [
      { key: "version", label: "Release Version", placeholder: "e.g. 2.83", val: v1, set: setV1 }
    ],
    testProgress: [
      { key: "version", label: "Release Version", placeholder: "e.g. 2.83", val: v1, set: setV1 }
    ]
  };

  const currentFields = fields[prompt.id] || [];
  const canSubmit = currentFields.every(f => f.val.trim());

  const handleSubmit = () => {
    if (!canSubmit) return;
    const vals = currentFields.map(f => f.val.trim());
    onSubmit(...vals);
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000
    }}>
      <div style={{
        background: "#0f172a", border: `1px solid ${prompt.color}40`,
        borderTop: `3px solid ${prompt.color}`, borderRadius: 12,
        padding: 32, width: 420, boxShadow: `0 0 60px ${prompt.color}20`
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
          <span style={{ fontSize: 24 }}>{prompt.icon}</span>
          <div>
            <div style={{ color: "#f1f5f9", fontWeight: 700, fontSize: 16, fontFamily: "'IBM Plex Mono', monospace" }}>
              {prompt.label}
            </div>
            <div style={{ color: "#64748b", fontSize: 12, marginTop: 2 }}>{prompt.description}</div>
          </div>
        </div>

        {currentFields.map(f => (
          <div key={f.key} style={{ marginBottom: 16 }}>
            <label style={{ display: "block", color: "#94a3b8", fontSize: 12, fontFamily: "'IBM Plex Mono',monospace", marginBottom: 6, letterSpacing: "0.05em", textTransform: "uppercase" }}>
              {f.label}
            </label>
            <input
              value={f.val}
              onChange={e => f.set(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleSubmit()}
              placeholder={f.placeholder}
              style={{
                width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 8, padding: "10px 14px", color: "#f1f5f9", fontSize: 14,
                fontFamily: "'IBM Plex Mono',monospace", outline: "none", boxSizing: "border-box",
                transition: "border-color 0.2s"
              }}
              autoFocus={f.key === currentFields[0].key}
            />
          </div>
        ))}

        <div style={{ display: "flex", gap: 10, marginTop: 24 }}>
          <button onClick={onClose} style={{
            flex: 1, padding: "10px 16px", background: "transparent",
            border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8,
            color: "#64748b", cursor: "pointer", fontSize: 14, fontFamily: "'IBM Plex Mono',monospace"
          }}>Cancel</button>
          <button onClick={handleSubmit} disabled={!canSubmit} style={{
            flex: 2, padding: "10px 16px",
            background: canSubmit ? `linear-gradient(135deg, ${prompt.color}cc, ${prompt.color})` : "rgba(255,255,255,0.05)",
            border: "none", borderRadius: 8, color: canSubmit ? "#000" : "#475569",
            cursor: canSubmit ? "pointer" : "not-allowed", fontSize: 14, fontWeight: 700,
            fontFamily: "'IBM Plex Mono',monospace", transition: "all 0.2s"
          }}>
            Launch →
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── SIDEBAR BUTTON ───────────────────────────────────────────────────────────
function PromptButton({ prompt, active, onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: "100%", textAlign: "left", padding: "12px 14px",
        background: active ? `${prompt.color}18` : hover ? "rgba(255,255,255,0.05)" : "transparent",
        border: active ? `1px solid ${prompt.color}50` : "1px solid transparent",
        borderRadius: 8, cursor: "pointer", transition: "all 0.2s", marginBottom: 6
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{
          width: 32, height: 32, borderRadius: 8,
          background: active ? `${prompt.color}30` : "rgba(255,255,255,0.07)",
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0,
          border: active ? `1px solid ${prompt.color}60` : "1px solid rgba(255,255,255,0.1)"
        }}>{prompt.icon}</span>
        <div>
          <div style={{ color: active ? prompt.color : "#cbd5e1", fontWeight: 600, fontSize: 13, fontFamily: "'IBM Plex Mono',monospace" }}>
            {prompt.label}
          </div>
          <div style={{ color: "#475569", fontSize: 11, marginTop: 2, lineHeight: 1.3 }}>
            {prompt.description}
          </div>
        </div>
      </div>
    </button>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [activePrompt, setActivePrompt] = useState(null);
  const [modal, setModal] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sessions, setSessions] = useState({});
  const chatEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const startPrompt = (promptId) => {
    setModal(promptId);
  };

  const handleModalSubmit = async (...args) => {
    const prompt = PROMPTS[modal];
    setModal(null);
    setActivePrompt(modal);

    let builtPrompt = "";
    if (modal === "runAnalysis") builtPrompt = prompt.buildPrompt(args[0], args[1]);
    else if (modal === "resumeAnalysis") builtPrompt = prompt.buildPrompt(args[0], args[1]);
    else builtPrompt = prompt.buildPrompt(args[0]);

    const sessionKey = `${modal}-${Date.now()}`;
    const initMsg = { role: "system", content: `Started: ${prompt.label}` };
    const userMsg = { role: "user", content: builtPrompt };

    setMessages([initMsg, { role: "assistant", content: prompt.initialMessage }, userMsg]);
    setSessions(s => ({ ...s, [sessionKey]: { prompt: modal, msgs: [userMsg] } }));

    await sendToAPI([{ role: "user", content: builtPrompt }]);
  };

  const sendToAPI = async (msgs) => {
    setLoading(true);
    try {
      const result = await callClaude(msgs);
      setMessages(prev => [...prev, { role: "assistant", content: result.text || "(No response)" }]);
    } catch (err) {
      setMessages(prev => [...prev, {
        role: "assistant",
        content: `❌ **Error:** ${err.message}\n\nCheck that your Atlassian MCP connection is active and try again.`
      }]);
    } finally {
      setLoading(false);
    }
  };

  const handleSend = async () => {
    if (!input.trim() || loading) return;
    const userMsg = { role: "user", content: input.trim() };
    const updatedMsgs = [...messages.filter(m => m.role !== "system"), userMsg];
    setMessages(prev => [...prev, userMsg]);
    setInput("");
    await sendToAPI(updatedMsgs);
  };

  const clearChat = () => {
    setMessages([]);
    setActivePrompt(null);
  };

  const promptList = Object.values(PROMPTS);

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@300;400;500;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #020b18; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
        input:focus { border-color: rgba(245,158,11,0.5) !important; box-shadow: 0 0 0 2px rgba(245,158,11,0.1); }
        .md-h1 { font-size: 20px; font-weight: 700; color: #f1f5f9; margin: 16px 0 8px; font-family: 'IBM Plex Mono', monospace; }
        .md-h2 { font-size: 17px; font-weight: 600; color: #e2e8f0; margin: 14px 0 6px; font-family: 'IBM Plex Mono', monospace; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 4px; }
        .md-h3 { font-size: 14px; font-weight: 600; color: #f59e0b; margin: 12px 0 4px; font-family: 'IBM Plex Mono', monospace; }
        .md-p { margin: 6px 0; color: #cbd5e1; font-size: 14px; }
        .md-code { background: rgba(245,158,11,0.1); border: 1px solid rgba(245,158,11,0.2); border-radius: 4px; padding: 2px 6px; font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #fbbf24; }
        .md-table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 13px; }
        .md-table td { border: 1px solid rgba(255,255,255,0.1); padding: 6px 10px; color: #cbd5e1; }
        .md-table tr:first-child td { background: rgba(255,255,255,0.06); font-weight: 600; color: #f1f5f9; font-family: 'IBM Plex Mono',monospace; font-size: 12px; }
        .md-ul { padding-left: 18px; margin: 6px 0; }
        .md-ul li { color: #94a3b8; margin: 3px 0; font-size: 14px; }
        @keyframes pulse { 0%,100%{opacity:0.4} 50%{opacity:1} }
        @keyframes fadeIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        .msg-in { animation: fadeIn 0.3s ease; }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>

      <div style={{ display: "flex", height: "100vh", background: "#020b18", fontFamily: "'IBM Plex Sans', sans-serif", overflow: "hidden" }}>

        {/* ── SIDEBAR ── */}
        <div style={{
          width: 300, background: "#080f1a", borderRight: "1px solid rgba(255,255,255,0.07)",
          display: "flex", flexDirection: "column", flexShrink: 0
        }}>
          {/* Logo */}
          <div style={{ padding: "24px 20px 16px", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 8,
                background: "linear-gradient(135deg,#f59e0b,#ef4444)",
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18
              }}>⚡</div>
              <div>
                <div style={{ color: "#f1f5f9", fontWeight: 700, fontSize: 14, fontFamily: "'IBM Plex Mono',monospace", letterSpacing: "0.02em" }}>
                  RELEASE OPS
                </div>
                <div style={{ color: "#475569", fontSize: 11 }}>Integration Analysis Suite</div>
              </div>
            </div>
          </div>

          {/* Jira Status */}
          <div style={{ padding: "12px 20px", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#10b981", boxShadow: "0 0 6px #10b981" }} />
              <span style={{ color: "#64748b", fontSize: 11, fontFamily: "'IBM Plex Mono',monospace" }}>ATLASSIAN MCP · CONNECTED</span>
            </div>
          </div>

          {/* Prompt Buttons */}
          <div style={{ flex: 1, padding: "16px 12px", overflowY: "auto" }}>
            <div style={{ color: "#334155", fontSize: 10, fontFamily: "'IBM Plex Mono',monospace", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10, paddingLeft: 4 }}>
              WORKFLOWS
            </div>
            {promptList.map(p => (
              <PromptButton key={p.id} prompt={p} active={activePrompt === p.id} onClick={() => startPrompt(p.id)} />
            ))}
          </div>

          {/* Footer */}
          <div style={{ padding: "12px 16px", borderTop: "1px solid rgba(255,255,255,0.07)" }}>
            <button onClick={clearChat} style={{
              width: "100%", padding: "8px", background: "transparent",
              border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6,
              color: "#475569", cursor: "pointer", fontSize: 12, fontFamily: "'IBM Plex Mono',monospace",
              transition: "all 0.2s"
            }}>
              ↺ Clear Chat
            </button>
          </div>
        </div>

        {/* ── MAIN PANEL ── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

          {/* Header */}
          <div style={{
            padding: "16px 28px", borderBottom: "1px solid rgba(255,255,255,0.07)",
            display: "flex", alignItems: "center", justifyContent: "space-between",
            background: "rgba(8,15,26,0.8)", backdropFilter: "blur(10px)"
          }}>
            <div>
              {activePrompt ? (
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 20 }}>{PROMPTS[activePrompt].icon}</span>
                  <div>
                    <div style={{ color: "#f1f5f9", fontWeight: 600, fontSize: 15, fontFamily: "'IBM Plex Mono',monospace" }}>
                      {PROMPTS[activePrompt].label}
                    </div>
                    <div style={{ color: "#475569", fontSize: 11 }}>{PROMPTS[activePrompt].description}</div>
                  </div>
                </div>
              ) : (
                <div>
                  <div style={{ color: "#f1f5f9", fontWeight: 600, fontSize: 15, fontFamily: "'IBM Plex Mono',monospace" }}>
                    Select a Workflow
                  </div>
                  <div style={{ color: "#475569", fontSize: 11 }}>Choose a prompt from the sidebar to begin</div>
                </div>
              )}
            </div>
            {loading && (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 16, height: 16, border: "2px solid rgba(245,158,11,0.3)", borderTop: "2px solid #f59e0b", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                <span style={{ color: "#f59e0b", fontSize: 12, fontFamily: "'IBM Plex Mono',monospace" }}>Analyzing...</span>
              </div>
            )}
          </div>

          {/* Chat Area */}
          <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px" }}>
            {messages.length === 0 ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 20 }}>
                <div style={{
                  width: 64, height: 64, borderRadius: 16,
                  background: "linear-gradient(135deg,rgba(245,158,11,0.2),rgba(239,68,68,0.2))",
                  border: "1px solid rgba(245,158,11,0.2)",
                  display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32
                }}>⚡</div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ color: "#94a3b8", fontSize: 16, fontWeight: 500, marginBottom: 8 }}>Release Impact Analysis Suite</div>
                  <div style={{ color: "#334155", fontSize: 13 }}>Select a workflow from the sidebar to get started</div>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center", maxWidth: 480 }}>
                  {promptList.map(p => (
                    <button key={p.id} onClick={() => startPrompt(p.id)} style={{
                      padding: "8px 16px", background: `${p.color}12`,
                      border: `1px solid ${p.color}30`, borderRadius: 20,
                      color: p.color, cursor: "pointer", fontSize: 13,
                      fontFamily: "'IBM Plex Mono',monospace", transition: "all 0.2s"
                    }}>
                      {p.icon} {p.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {messages.map((msg, i) => (
                  <div key={i} className="msg-in">
                    <MessageBubble msg={msg} />
                  </div>
                ))}
                {loading && (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0" }}>
                    <div style={{ width: 32, height: 32, borderRadius: "50%", background: "linear-gradient(135deg,#f59e0b,#ef4444)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>⚡</div>
                    <div style={{ display: "flex", gap: 5 }}>
                      {[0, 1, 2].map(i => (
                        <div key={i} style={{ width: 7, height: 7, borderRadius: "50%", background: "#f59e0b", animation: "pulse 1.2s ease infinite", animationDelay: `${i * 0.2}s` }} />
                      ))}
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </>
            )}
          </div>

          {/* Input Bar */}
          <div style={{
            padding: "16px 28px", borderTop: "1px solid rgba(255,255,255,0.07)",
            background: "rgba(8,15,26,0.9)", backdropFilter: "blur(10px)"
          }}>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                placeholder="Ask a follow-up question or provide additional context..."
                rows={1}
                style={{
                  flex: 1, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 10, padding: "12px 16px", color: "#f1f5f9", fontSize: 14,
                  fontFamily: "'IBM Plex Sans',sans-serif", outline: "none", resize: "none",
                  lineHeight: 1.5, transition: "border-color 0.2s", minHeight: 48, maxHeight: 120
                }}
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || loading}
                style={{
                  padding: "12px 20px", height: 48, flexShrink: 0,
                  background: input.trim() && !loading ? "linear-gradient(135deg,#f59e0b,#ef4444)" : "rgba(255,255,255,0.06)",
                  border: "none", borderRadius: 10,
                  color: input.trim() && !loading ? "#000" : "#334155",
                  cursor: input.trim() && !loading ? "pointer" : "not-allowed",
                  fontSize: 16, fontWeight: 700, transition: "all 0.2s"
                }}
              >→</button>
            </div>
            <div style={{ color: "#1e293b", fontSize: 11, marginTop: 8, fontFamily: "'IBM Plex Mono',monospace" }}>
              Enter to send · Shift+Enter for new line · Powered by Claude + Atlassian MCP
            </div>
          </div>
        </div>
      </div>

      {/* Modal */}
      {modal && (
        <InputModal prompt={PROMPTS[modal]} onSubmit={handleModalSubmit} onClose={() => setModal(null)} />
      )}
    </>
  );
}
