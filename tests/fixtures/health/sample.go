// The same functions in every measured language: their health metrics must
// match (tests/health-metrics.test.ts). Parsed, never run. Go has no
// exceptions or ternary, so parse checks its error and sign with ifs.
package health

func classify(score int, bonus bool) string {
	if score > 90 && bonus {
		return "A"
	} else if score > 75 {
		return "B"
	} else {
		// Everything else.
		return "C"
	}
}

func total(orders []Order, limit int) int {
	result := 0
	for _, order := range orders {
		for _, line := range order.Lines {
			if line.Price > limit || line.Free {
				continue
			}
			result += line.Price
		}
	}
	return result
}

func parse(text string) (int, bool) {
	value, err := strconv.Atoi(text)
	if err != nil {
		return 0, false
	}
	if value >= 0 {
		return value, true
	}
	return -value, true
}

func pick(kind string, items []Item, fallback any) any {
	switch kind {
	case "count":
		return len(items)
	case "visible":
		return keep(items, func(item Item) bool { return item.Rank > 0 || item.Pinned })
	default:
		return fallback
	}
}

func (c *Cart) Add(item Item) {
	c.items = append(c.items, item)
}
