const states: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC",
};
const namesByAbbreviation = Object.fromEntries(
  Object.entries(states).map(([name, abbreviation]) => [abbreviation, name]),
);
const clean = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function formatCurrentLocation(city?: string, state?: string) {
  if (!city) return undefined;
  const abbreviation = state ? (states[clean(state)] ?? state) : undefined;
  return [city, abbreviation].filter(Boolean).join(", ");
}

function parts(value: string) {
  const split = value.split(",").map((part) => part.trim());
  const city = clean(split[0] ?? "");
  const regionRaw = clean(split[1] ?? "").toUpperCase();
  const region = states[clean(split[1] ?? "")] ?? regionRaw;
  return { city, region, normalized: clean(value) };
}

export function locationCandidates(value: string) {
  const target = parts(value),
    values = [value];
  if (target.city && target.region) {
    const displayCity = value.split(",")[0].trim(),
      fullState = namesByAbbreviation[target.region];
    values.push(`${displayCity}, ${target.region}, United States`);
    if (fullState) {
      const titleState = fullState.replace(/\b\w/g, (letter) =>
        letter.toUpperCase(),
      );
      values.push(`${displayCity}, ${titleState}`);
      values.push(`${displayCity}, ${titleState}, United States`);
    }
  }
  return [...new Set(values)];
}

export function locationOptionScore(expected: string, option: string) {
  const target = parts(expected),
    candidate = parts(option);
  if (!target.city || !candidate.city) return 0;
  if (target.normalized === candidate.normalized) return 100;
  if (target.city === candidate.city && target.region === candidate.region)
    return 90;
  if (target.city === candidate.city) return 70;
  // A metro result is acceptable only when it explicitly names the real city too.
  if (
    candidate.normalized.includes(target.city) &&
    /portland/.test(candidate.normalized) &&
    target.city === "beaverton"
  )
    return 60;
  return 0;
}
