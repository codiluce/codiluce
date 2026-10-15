"""The same functions in every measured language: their health metrics must
match (tests/health-metrics.test.ts). Parsed, never run."""


def classify(score, bonus):
    if score > 90 and bonus:
        return "A"
    elif score > 75:
        return "B"
    else:
        # Everything else.
        return "C"


def total(orders, limit):
    result = 0
    for order in orders:
        for line in order.lines:
            if line.price > limit or line.free:
                continue
            result += line.price
    return result


def parse(text):
    value = None
    try:
        value = int(text)
    except ValueError:
        return None
    return value if value >= 0 else -value


def pick(kind, items, fallback):
    match kind:
        case "count":
            return len(items)
        case "visible":
            return list(filter(lambda item: item.rank > 0 or item.pinned, items))
        case _:
            return fallback


class Cart:
    def add(self, item):
        self.items.append(item)
