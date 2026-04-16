# Black Gold Trading Bot

AI-powered commodity trading bot that analyzes news and momentum to generate BUY/SELL/HOLD signals.

## Features

### Signal Generation

| Component | Weight | Description |
|-----------|--------|-------------|
| AI Analysis | 80% | NVIDIA Nemotron + Groq GPT-OSS analyze news headlines |
| Momentum | 20% | RSI(14), intraday change, position in daily range, trend alignment |

**Signal thresholds:**
- BUY: blended score > +50
- SELL: blended score < -15
- HOLD: otherwise

### AI Confidence Scoring

The AI returns a confidence score (0-100%) based on:
- Explicit `confidence` field in AI response
- Fallback: derived from score magnitude (`|score| / 100`)

**Minimum confidence threshold: 70%** — orders below this are skipped to avoid low-conviction trades.

### Multi-Timeframe Momentum

Combines momentum signals across timeframes:
- **Intraday**: 24h price change (±5% maps to ±40 pts)
- **RSI(14)**: Overbought/oversold indicator (±40 pts)
- **Daily range**: Position within day's high/low (±20 pts)
- **7-day trend**: Percentage change over 7 days (±20 pts)
- **30-day trend**: Percentage change over 30 days (±20 pts)

**Trend alignment bonus**: When AI and momentum agree directionally, momentum weight is full; when opposing, it's halved.

### Risk Management

#### Stop Loss & Take Profit
- **Stop loss**: 2% (or ATR × 1.5 if available)
- **Take profit**: 3%

#### Trailing Stop
- Activates at **+1%** gain (moves to breakeven + 2%)
- Trails price at **2%** below peak
- Triggered via Telegram alert

#### Position Aging
- Positions held **>24 hours** have order size reduced by **50%**
- Prevents over-exposure to stale positions

### News Processing
- RSS feeds + NewsAPI + Trump Truth Social posts
- Relevance filter per ticker
- 5-hour cutoff window
- SHA-1 hash tracking prevents duplicate trades on unchanged news

## Configuration

```typescript
// config.ts
STOP_LOSS_PCT = 2                    // Fixed stop loss percentage
TAKE_PROFIT_PCT = 3                  // Fixed take profit percentage
MIN_CONFIDENCE_THRESHOLD = 70        // Minimum AI confidence to trade
POSITION_AGE_HOURS = 24              // Age before size reduction
AGED_POSITION_SIZE_MULTIPLIER = 0.5   // Size reduction after 24h
TRAILING_BREAKEVEN_PCT = 1           // Gain % to activate trailing stop
TRAILING_STOP_PCT = 2                // Trailing stop distance
ATR_STOP_MULTIPLIER = 1.5            // ATR multiplier for dynamic stops
MAX_DRAWDOWN_PCT = 5                 // Max daily loss before pause
```

## Redis Data

| Key | Type | Description |
|-----|------|-------------|
| `{prefix}:journal` | List | Complete trade journal with all signals and outcomes |
| `{prefix}:lastNewsHash` | String | Current news hash to detect changes |
| `{prefix}:positionOpenTime` | String | ISO timestamp when position opened |
| `{prefix}:trailingStopPrice` | String | Current trailing stop price |

## Output Format

```json
{
  "timestamp": "2026-04-16T12:00:00.000Z",
  "signal": "BUY",
  "netScore": 65,
  "aiScore": 75,
  "momentumScore": 20,
  "confidence": 75,
  "rsi": 58.4,
  "atr": 1.234,
  "trend7d": 2.5,
  "trend30d": -1.2,
  "price": 78.50,
  "changePct": 1.2,
  "order": { "id": "..." },
  "reasoning": "Oil supplies tightening...",
  "relevantHeadlines": [...]
}
```

## Running

```bash
npm run build
npm start           # Both BTC and Brent
npm run bitcoin      # BTC only
npm run brent       # Brent only
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `TRADING212_TOKEN` | Trading212 API token |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis token |
| `OPENROUTER_API_KEY` | OpenRouter API key (Nemotron) |
| `GROQ_API_KEY` | Groq API key (fallback) |
| `NEWS_API_KEY` | NewsAPI key |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Telegram chat ID |

## Journal Analysis

To analyze trade performance, query the Redis journal:

```bash
redis-cli
> LRANGE brent:journal 0 -1 | jq '.signal, .netScore, .order'
```

The journal captures every signal cycle including:
- Entry/exit prices
- AI reasoning
- Momentum metrics
- News headlines
- Order outcomes
