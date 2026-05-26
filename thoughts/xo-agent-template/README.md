# 🤖 XO Agent Workspace Template

> A ready-to-use template for configuring AI agents (Moltbot, Claude Code, custom agents) as your **Autonomous Digital Agency**.

[![XO](https://img.shields.io/badge/Powered%20by-XO-38bdf8?style=flat-square)](https://xo.builders)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

---

## 🚀 Quick Start

### Option 1: Use as GitHub Template

1. Click **"Use this template"** above
2. Clone your new repository
3. Copy `workspace/` contents to your agent workspace (`~/clawd` for Moltbot)
4. Customize files for your use case

### Option 2: Manual Setup

```bash
# Clone the template
git clone https://github.com/xo-builders/xo-agent-template.git

# Copy to your agent workspace
cp -r xo-agent-template/workspace/* ~/clawd/

# Customize your files
code ~/clawd
```

---

## 📁 Repository Structure

```
xo-agent-template/
├── README.md                    # This file
├── LICENSE                      # MIT License
├── workspace/                   # Agent workspace files
│   ├── SOUL.md                  # Personality & values
│   ├── USER.md                  # User profile template
│   ├── IDENTITY.md              # Agent identity
│   ├── AGENTS.md                # Operating instructions
│   ├── TOOLS.md                 # Tool-specific notes
│   ├── BOOTSTRAP.md             # First-run setup
│   ├── MEMORY.md                # Long-term memory
│   ├── memory/                  # Daily logs directory
│   │   └── .gitkeep
│   └── skills/                  # Custom skills directory
│       └── .gitkeep
└── .github/
    └── TEMPLATE_CONFIG.md       # Template customization guide
```

---

## 📄 Configuration Files

| File | Purpose | When Loaded |
|------|---------|-------------|
| `SOUL.md` | Agent personality, tone, values, boundaries | Every session |
| `USER.md` | Your profile, preferences, priorities | Every session |
| `IDENTITY.md` | Agent name, emoji, vibe | Every session |
| `AGENTS.md` | Operating rules, safety, behavior | Every session |
| `TOOLS.md` | Tool-specific instructions | On tool use |
| `BOOTSTRAP.md` | First-run onboarding (self-deletes) | First run only |
| `MEMORY.md` | Curated long-term memory | Private sessions |

---

## 🎯 Use Cases

This template is pre-configured for an **Executive Admin AI** but can be adapted for:

- 🏢 **Executive Assistant** — Calendar, email, meetings
- 💻 **Developer Agent** — Code reviews, deployments, documentation
- 📊 **Research Agent** — Market research, competitive analysis
- 🎨 **Creative Agent** — Content creation, social media
- 🤝 **Sales Agent** — Lead qualification, follow-ups
- 🛠️ **DevOps Agent** — Monitoring, incident response

---

## ⚡ Quick Customization

### 1. Update Your Identity

Edit `workspace/USER.md`:

```markdown
## Identity
- **Name**: Your Name
- **Role**: Your Role
- **Company**: Your Company
```

### 2. Set Agent Personality

Edit `workspace/SOUL.md` to match your preferred tone:

```markdown
## Voice & Tone
- Professional but warm
- Concise—you're busy
- Proactive—anticipate needs
```

### 3. Configure Tools

Edit `workspace/TOOLS.md` with your actual tools:

```markdown
## Calendar
- Primary: your.email@company.com
- Tool: Google Calendar / Outlook

## Communication
- Slack workspace: your-workspace
- Key channels: #team, #alerts
```

---

## 🔐 Security Best Practices

1. **Never commit secrets** — Use environment variables
2. **Review AGENTS.md boundaries** — Set clear escalation rules
3. **Sandbox first** — Start with limited permissions
4. **Audit regularly** — Check memory files for sensitive data
5. **Use .gitignore** — Exclude personal data from commits

---

## 🔗 Compatible Agents

This template works with:

- [Moltbot](https://molt.bot) (formerly Clawdbot)
- [Claude Code](https://claude.ai/code)
- Custom agents using the AGENTS.md standard

---

## 📚 Resources

- [XO Documentation](https://xo.builders/docs)
- [Moltbot Docs](https://docs.molt.bot)
- [AGENTS.md Standard](https://agents.md)
- [SOUL.md Concept](https://soul.md)

---

## 🤝 Contributing

Contributions welcome! Please read our contributing guidelines first.

1. Fork this repository
2. Create a feature branch
3. Submit a pull request

---

## 📝 License

MIT License — see [LICENSE](LICENSE) for details.

---

<p align="center">
  <strong>Built with 🦞 by <a href="https://xo.builders">XO</a></strong>
  <br>
  <em>AI Agents. Real Clients. 24/7.</em>
</p>
