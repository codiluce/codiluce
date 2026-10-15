<?php
// The same functions in every measured language: their health metrics must
// match (tests/health-metrics.test.ts). Parsed, never run.

function classify(int $score, bool $bonus): string
{
    if ($score > 90 && $bonus) {
        return 'A';
    } elseif ($score > 75) {
        return 'B';
    } else {
        // Everything else.
        return 'C';
    }
}

function total(array $orders, int $limit): int
{
    $result = 0;
    foreach ($orders as $order) {
        foreach ($order->lines as $line) {
            if ($line->price > $limit || $line->free) {
                continue;
            }
            $result += $line->price;
        }
    }
    return $result;
}

function parse(string $text): ?int
{
    $value = null;
    try {
        $value = strictInteger($text);
    } catch (InvalidArgumentException $error) {
        return null;
    }
    return $value >= 0 ? $value : -$value;
}

function pick(string $kind, array $items, array $fallback): array|int
{
    switch ($kind) {
        case 'count':
            return count($items);
        case 'visible':
            return array_filter($items, fn($item) => $item->rank > 0 || $item->pinned);
        default:
            return $fallback;
    }
}

class Cart
{
    public function add(Item $item): void
    {
        $this->items[] = $item;
    }
}
