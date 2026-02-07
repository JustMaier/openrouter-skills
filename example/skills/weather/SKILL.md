---
name: weather
description: Get current weather for any city. Use when the user asks about weather conditions or temperature.
---

# Weather Skill

This skill provides a CLI interface for retrieving current weather data for any city.

## Usage

Run commands via `weather.mjs`:

### Get forecast

```bash
node weather.mjs forecast <city>
```

Returns JSON weather data including temperature, conditions, and humidity for the specified city.

### Specify units

```bash
node weather.mjs forecast <city> --units=celsius
node weather.mjs forecast <city> --units=fahrenheit
```

The default unit is celsius. Use the `--units` flag to switch to fahrenheit.

**Parameters:**

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `<city>` | Yes | -- | City name to get weather for |
| `--units=celsius\|fahrenheit` | No | celsius | Temperature unit |

## Examples

```bash
# Get weather for London in celsius (default)
node weather.mjs forecast London

# Get weather for Tokyo in fahrenheit
node weather.mjs forecast Tokyo --units=fahrenheit

# Multi-word city names
node weather.mjs forecast "New York" --units=celsius
```
