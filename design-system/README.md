# Ad Sensei — Component Library

Preview pages for the Ad Sensei design system, one component/token per file,
each marked with `<!-- @dsCard group="…" -->` so it renders as a card in a
Claude Design project.

**Spec (source of truth for tokens & voice):** see `../DESIGN_SYSTEM.md`.

**Sync to Claude Design:**

```
cd design-system
claude
› /design-sync
```

## Cards

| File | Group | Component |
| --- | --- | --- |
| `brand.html` | Brand | Logo mark + voice |
| `colors.html` | Foundations | Color tokens (light + dark) |
| `typography.html` | Foundations | Type scale |
| `toggle.html` | Components | Toggle switch |
| `buttons.html` | Components | Pill buttons |
| `tooltip.html` | Components | ⓘ info tooltip |
| `card.html` | Components | Feature card |
| `stats.html` | Components | Stat table |

All previews use the real product tokens: accent `#7c3aed`, Roboto, dark-first.
