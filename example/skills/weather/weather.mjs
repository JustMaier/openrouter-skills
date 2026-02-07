#!/usr/bin/env node

const args = process.argv.slice(2);

function printError(message) {
  console.error(JSON.stringify({ error: message }));
  process.exit(1);
}

/**
 * Simple string hash that produces a consistent unsigned 32-bit integer.
 * Used to generate deterministic mock data that varies per city.
 */
function hashCity(name) {
  const normalized = name.toLowerCase().trim();
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

const CONDITIONS = [
  "sunny",
  "partly cloudy",
  "cloudy",
  "overcast",
  "light rain",
  "rainy",
  "thunderstorms",
  "snowy",
  "foggy",
  "windy",
];

function handleForecast(args) {
  let units = "celsius";
  const cityParts = [];

  for (const arg of args) {
    if (arg.startsWith("--units=")) {
      const value = arg.slice("--units=".length).toLowerCase();
      if (value !== "celsius" && value !== "fahrenheit") {
        printError(`Invalid units: "${value}". Must be "celsius" or "fahrenheit".`);
      }
      units = value;
    } else {
      cityParts.push(arg);
    }
  }

  const city = cityParts.join(" ");

  if (!city) {
    printError("Missing required argument: <city>");
  }

  const hash = hashCity(city);

  // Generate deterministic temperature between -10 and 40 celsius
  const tempCelsius = (hash % 51) - 10;
  const temperature = units === "fahrenheit"
    ? Math.round(tempCelsius * 9 / 5 + 32)
    : tempCelsius;

  const conditions = CONDITIONS[hash % CONDITIONS.length];
  const humidity = 30 + (hash % 61); // 30-90%

  const result = {
    city,
    temperature,
    units,
    conditions,
    humidity,
  };

  console.log(JSON.stringify(result, null, 2));
}

// --- Main ---

if (args.length === 0) {
  printError("No command provided. Available commands: forecast <city> [--units=celsius|fahrenheit]");
}

const command = args[0];

if (command === "forecast") {
  handleForecast(args.slice(1));
} else {
  printError(`Unknown command: "${command}". Available commands: forecast <city> [--units=celsius|fahrenheit]`);
}
