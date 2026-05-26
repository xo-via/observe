# Template Configuration Guide

## Making This Repository a GitHub Template

1. Go to repository Settings
2. Check "Template repository" under the repository name
3. The "Use this template" button will appear for users

## Customization Checklist

After using this template, update these files:

### Required Changes

- [ ] `workspace/USER.md` — Fill in your personal details
- [ ] `workspace/TOOLS.md` — Update with your actual tools
- [ ] `workspace/IDENTITY.md` — Customize agent name if desired
- [ ] `workspace/AGENTS.md` — Adjust escalation rules for your context

### Optional Changes

- [ ] `workspace/SOUL.md` — Modify personality/tone
- [ ] `workspace/MEMORY.md` — Add initial context
- [ ] `README.md` — Update for your use case

### First Run

1. Copy `workspace/` contents to your agent directory
2. Complete the `BOOTSTRAP.md` setup flow
3. The bootstrap file will self-delete after setup

## Recommended Repository Settings

### Branch Protection
- Require pull request reviews for `main`
- Prevent direct pushes to `main`

### Security
- Enable Dependabot alerts
- Enable secret scanning

## Contributing Back

If you improve these templates, consider contributing back:

1. Fork the original XO template
2. Make your improvements
3. Submit a pull request

---

*Maintained by [XO](https://xo.builders)*
