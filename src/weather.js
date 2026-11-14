/**
 * Free weather forecast integration via Open-Meteo (No API key needed).
 * Default coordinates set to Phnom Penh, Cambodia (11.5564° N, 104.9282° E).
 */

const WMO_WEATHER_CODES = {
  0: { label: 'Clear Sky (មេឃស្រឡះ)', emoji: '☀️' },
  1: { label: 'Mainly Clear (មេឃស្រឡះ)', emoji: '🌤️' },
  2: { label: 'Partly Cloudy (មានពពកតិចតួច)', emoji: '⛅' },
  3: { label: 'Overcast (មេឃស្រទុំ/ពពកច្រើន)', emoji: '☁️' },
  45: { label: 'Foggy (មានអ័ព្ទ)', emoji: '🌫️' },
  48: { label: 'Depositing Rime Fog', emoji: '🌫️' },
  51: { label: 'Light Drizzle (រលឹមតិចតួច)', emoji: '🌦️' },
  53: { label: 'Moderate Drizzle (រលឹមល្មម)', emoji: '🌦️' },
  55: { label: 'Dense Drizzle (រលឹមខ្លាំង)', emoji: '🌧️' },
  61: { label: 'Slight Rain (ភ្លៀងតិចតួច)', emoji: '🌦️' },
  63: { label: 'Moderate Rain (ភ្លៀងបង្គួរ)', emoji: '🌧️' },
  65: { label: 'Heavy Rain (ភ្លៀងធ្លាក់ខ្លាំង)', emoji: '⛈️' },
  80: { label: 'Rain Showers (មានភ្លៀងធ្លាក់ជាកន្លែង)', emoji: '🌦️' },
  81: { label: 'Heavy Showers (ភ្លៀងធ្លាក់ខ្លាំង)', emoji: '🌧️' },
  82: { label: 'Violent Showers (ភ្លៀងខ្លាំង)', emoji: '⛈️' },
  95: { label: 'Thunderstorm (ផ្គររន្ទះ)', emoji: '⚡' },
  96: { label: 'Thunderstorm with Hail', emoji: '⛈️' },
  99: { label: 'Heavy Thunderstorm', emoji: '⛈️' },
};

export async function getPhnomPenhWeather(lat = 11.5564, lon = 104.9282) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FBangkok&forecast_days=1`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Weather service responded with status ${res.status}`);
    }

    const data = await res.json();
    const current = data.current || {};
    const daily = data.daily || {};

    const code = current.weather_code ?? 0;
    const weatherInfo = WMO_WEATHER_CODES[code] || { label: 'Fair (ធម្មតា)', emoji: '🌤️' };

    const tempCurrent = Math.round(current.temperature_2m ?? 30);
    const tempFeelsLike = Math.round(current.apparent_temperature ?? tempCurrent);
    const tempMax = Math.round(daily.temperature_2m_max?.[0] ?? tempCurrent);
    const tempMin = Math.round(daily.temperature_2m_min?.[0] ?? 24);
    const rainProb = daily.precipitation_probability_max?.[0] ?? 0;
    const humidity = current.relative_humidity_2m ?? 70;
    const windSpeed = Math.round(current.wind_speed_10m ?? 10);

    return {
      success: true,
      city: 'Phnom Penh (រាជធានីភ្នំពេញ)',
      tempCurrent,
      tempFeelsLike,
      tempMax,
      tempMin,
      rainProb,
      humidity,
      windSpeed,
      condition: weatherInfo.label,
      emoji: weatherInfo.emoji,
      summaryText: `${weatherInfo.emoji} ${tempCurrent}°C (${weatherInfo.label}) | អតិបរមា: ${tempMax}°C, អប្បបរមា: ${tempMin}°C | ឱកាសភ្លៀង: ${rainProb}%`,
    };
  } catch (err) {
    console.warn('⚠️ Could not fetch weather:', err.message);
    return {
      success: false,
      summaryText: '🌤️ 30°C (Phnom Penh) — Have a great day!',
    };
  }
}
