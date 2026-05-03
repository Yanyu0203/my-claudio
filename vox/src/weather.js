/**
 * 和风天气查询
 * --------------------------------------------------
 * 文档: https://dev.qweather.com/docs/api/weather/weather-now/
 *
 * 注册步骤：
 *   1. https://dev.qweather.com/ 注册账号
 *   2. 控制台 → 应用管理 → 创建应用（凭据类型选 API KEY）
 *   3. 拿到 API KEY、API Host (xxxxx.re.qweatherapi.com)
 *   4. 控制台 → 数据服务 → 城市信息查询，搜你的城市拿到 LocationID
 *   5. .env 填三个：QWEATHER_KEY / QWEATHER_HOST / QWEATHER_LOCATION
 *
 * 缓存：30 分钟，落 SQLite weather_cache 表（重启不丢）
 * 没配置 key 时返回 null
 */
import { cacheGet, cacheSet } from './db.js';

const CACHE_MS = 30 * 60 * 1000;

/**
 * @returns {Promise<{text:string, temp:number, feelsLike:number, humidity:number, windDir:string, summary:string, theme:string}|null>}
 */
export async function getWeather() {
  const enabled = process.env.ENABLE_WEATHER === 'true';
  const key = process.env.QWEATHER_KEY;
  const host = process.env.QWEATHER_HOST;
  const loc = process.env.QWEATHER_LOCATION;

  if (!enabled || !key || !host || !loc) return null;

  // 先看 SQLite 缓存
  const cached = cacheGet('weather_cache', loc);
  if (cached) return cached;

  try {
    const url = `https://${host}/v7/weather/now?location=${loc}&key=${key}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      console.warn('[weather] HTTP', res.status);
      return null;
    }
    const json = await res.json();
    if (json.code !== '200') {
      console.warn('[weather] biz code', json.code);
      return null;
    }
    const n = json.now;
    const data = {
      text: n.text,
      temp: Number(n.temp),
      feelsLike: Number(n.feelsLike),
      humidity: Number(n.humidity),
      windDir: n.windDir,
      icon: n.icon,
      summary: `${n.text}, ${n.temp}°C, 体感${n.feelsLike}°C, 湿度${n.humidity}%, ${n.windDir}`,
      theme: pickTheme(n.text, n.icon),
    };
    cacheSet('weather_cache', loc, data, CACHE_MS);
    return data;
  } catch (e) {
    console.warn('[weather] fetch error', e.message);
    return null;
  }
}

/**
 * 把和风的 text/icon 映射成前端主题
 * 同时考虑当前时间（夜晚优先用 night 主题）
 */
function pickTheme(text, icon) {
  const hour = new Date().getHours();
  const isNight = hour >= 19 || hour < 6;

  // 夜晚专用主题（除了下雨下雪还是按天气走）
  if (isNight && !/雨|雪|雷/.test(text)) return 'night';

  if (/雷/.test(text)) return 'storm';
  if (/雨/.test(text)) return 'rain';
  if (/雪/.test(text)) return 'snow';
  if (/雾|霾|沙|尘/.test(text)) return 'fog';
  if (/阴/.test(text)) return 'overcast';
  if (/云/.test(text)) return 'cloud';
  if (/晴/.test(text)) return 'sun';
  return 'cyber';
}
