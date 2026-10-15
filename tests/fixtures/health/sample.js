// The same functions in every measured language: their health metrics must
// match (tests/health-metrics.test.ts). Parsed, never run.
export function classify(score, bonus) {
  if (score > 90 && bonus) {
    return 'A';
  } else if (score > 75) {
    return 'B';
  } else {
    // Everything else.
    return 'C';
  }
}

export function total(orders, limit) {
  let result = 0;
  for (const order of orders) {
    for (const line of order.lines) {
      if (line.price > limit || line.free) {
        continue;
      }
      result += line.price;
    }
  }
  return result;
}

export function parse(text) {
  let value;
  try {
    value = strictInteger(text);
  } catch (error) {
    return null;
  }
  return value >= 0 ? value : -value;
}

export function pick(kind, items, fallback) {
  switch (kind) {
    case 'count':
      return items.length;
    case 'visible':
      return items.filter(item => item.rank > 0 || item.pinned);
    default:
      return fallback;
  }
}

export class Cart {
  add(item) {
    this.items.push(item);
  }
}
