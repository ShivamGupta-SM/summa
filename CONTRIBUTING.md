# Contributing to Summa

Thank you for your interest in contributing to Summa! This guide will help you get started.

## Development Setup

### Prerequisites

- [Node.js](https://nodejs.org/) v22+
- [pnpm](https://pnpm.io/) v10+
- [Docker](https://www.docker.com/) (for PostgreSQL integration tests)

### Getting Started

1. Fork and clone the repository:

```bash
git clone https://github.com/ShivamGupta-SM/summa.git
cd summa
```

2. Install dependencies:

```bash
pnpm install
```

3. Build all packages:

```bash
pnpm build
```

4. Run tests:

```bash
pnpm test
```

### Running Integration Tests

Integration tests require a PostgreSQL database. Start one with Docker:

```bash
docker compose up -d
```

Then run tests:

```bash
DATABASE_URL=postgres://summa:summa@localhost:5432/summa_test pnpm test
```

## Project Structure

```
summa/
├── packages/
│   ├── core/              # @summa/core — types, adapter interface, errors, utils
│   ├── summa/             # summa — main library with managers + plugins
│   ├── drizzle-adapter/   # @summa/drizzle-adapter — PostgreSQL via Drizzle
│   ├── prisma-adapter/    # @summa/prisma-adapter — PostgreSQL via Prisma
│   ├── kysely-adapter/    # @summa/kysely-adapter — PostgreSQL via Kysely
│   ├── memory-adapter/    # @summa/memory-adapter — In-memory for testing
│   ├── cli/               # @summa/cli — CLI tool
│   └── test-utils/        # @summa/test-utils — Test helpers
├── turbo.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

## Development Workflow

### Scripts

| Command | Description |
|---------|-------------|
| `pnpm build` | Build all packages |
| `pnpm test` | Run all tests |
| `pnpm lint` | Lint with Biome |
| `pnpm lint:fix` | Auto-fix lint issues |
| `pnpm format` | Format with Biome |
| `pnpm typecheck` | Type check all packages |
| `pnpm lint:packages` | Validate package exports with publint |

### Making Changes

1. Create a feature branch from `main`
2. Make your changes
3. Add tests for any new functionality
4. Run `pnpm lint && pnpm test && pnpm typecheck` to verify
5. Create a changeset: `pnpm changeset`
6. Submit a pull request

### Changesets

We use [Changesets](https://github.com/changesets/changesets) for version management. When making changes that should be released:

```bash
pnpm changeset
```

Follow the prompts to describe your changes and select the appropriate version bump.

### Code Style

- We use [Biome](https://biomejs.dev/) for linting and formatting
- Tab indentation, double quotes, semicolons
- Organize imports automatically
- Run `pnpm lint:fix` to auto-fix issues

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — New feature
- `fix:` — Bug fix
- `docs:` — Documentation changes
- `refactor:` — Code refactoring
- `test:` — Test changes
- `chore:` — Build/tooling changes

## Reporting Issues

- Use [GitHub Issues](https://github.com/ShivamGupta-SM/summa/issues) for bug reports and feature requests
- Search existing issues before creating a new one
- Include reproduction steps for bugs

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE.md).
