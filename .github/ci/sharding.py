def balance(weights, count):
    shards = [[] for _ in range(min(count, len(weights)))]
    totals = [0.0] * len(shards)
    for name in sorted(weights, key=lambda item: (-weights[item], item)):
        index = min(range(len(shards)), key=lambda i: (totals[i], len(shards[i]), i))
        shards[index].append(name)
        totals[index] += weights[name]
    return shards
