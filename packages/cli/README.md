# @summa/cli

Command-line interface for the Summa ledger.

## Installation

```bash
npm install -g @summa/cli
```

## Usage

```bash
# Initialize a new Summa project
summa init

# Generate migrations and types
summa generate

# Run database migrations
summa migrate

# Check ledger status
summa status

# Verify ledger integrity
summa verify

# Show environment info
summa info

# Manage secrets
summa secret

# Toggle anonymous telemetry
summa telemetry on|off
```

### Options

```bash
summa --cwd <dir>          # Set working directory
summa -c, --config <path>  # Path to summa config file
summa -v, --version        # Show version
```

## Documentation

Full documentation available at [https://summa.dev](https://summa.dev).

## License

MIT
