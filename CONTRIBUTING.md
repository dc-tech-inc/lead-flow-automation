# Contributing

1. Branch from `main` (`feat/...`, `fix/...`) and use [Conventional Commits](https://www.conventionalcommits.org/).
2. Run the checks before pushing: `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm build`.
   Scraper changes: see `services/scraper/README.md`.
3. Open a pull request. CI must be green; maintainers merge with a merge commit (no squash).
4. Never commit secrets or real personal data. Use `.env.example` for new settings and `example.com` addresses in tests and seeds.
5. Behaviour changes need a test; decisions worth remembering get a short ADR in `docs/adr/`.
