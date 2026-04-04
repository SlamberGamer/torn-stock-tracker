const fetch = require("node-fetch");

const COUNTRIES = [
  { name: "Mexico",        cc: "mex", flightMins: 18  },
  { name: "Cayman Islands",cc: "cay", flightMins: 25  },
  { name: "Canada",        cc: "can", flightMins: 29  },
  { name: "Hawaii",        cc: "haw", flightMins: 94  },
  { name: "United Kingdom",cc: "uni", flightMins: 111 },
  { name: "Argentina",     cc: "arg", flightMins: 117 },
  { name: "Switzerland",   cc: "swi", flightMins: 123 },
  { name: "Japan",         cc: "jap", flightMins: 158 },
  { name: "China",         cc: "chi", flightMins: 169 },
  { name: "UAE",           cc: "uae", flightMins: 190 },
  { name: "South Africa",  cc: "sou", flightMins: 208 },
];

async function fetchCountry(countryName) {
  const url = `https://droqsdb.com/api/public/v1/country/${encodeURIComponent(countryName)}`;
  const res  = await fetch(url, { timeout: 10000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error("DroqsDB ok=false");
  return data.country;
}

async function fetchAllCountries() {
  const results = await Promise.allSettled(
    COUNTRIES.map(async (c) => {
      const data = await fetchCountry(c.name);
      return { ...c, items: data.items || [] };
    })
  );

  return results
    .filter(r => r.status === "fulfilled")
    .map(r => r.value);
}

module.exports = { fetchAllCountries, COUNTRIES };
