def balance(weights, count, *, serial_seconds=None):
    shards = [[] for _ in range(min(count, len(weights)))]

    def distribute(names, seconds):
        totals = [sum(seconds[name] for name in shard) for shard in shards]
        for name in sorted(names, key=lambda item: (-seconds[item], item)):
            index = min(range(len(shards)), key=lambda i: (totals[i], len(shards[i]), i))
            shards[index].append(name)
            totals[index] += seconds[name]

    # Browser-locked cases run one at a time per worker. Balance that work first,
    # then fill by total time, including ordinary cases in mixed classes.
    locked = weights.keys() & (serial_seconds or {}).keys()
    if locked:
        distribute(locked, serial_seconds)
    distribute(weights.keys() - locked, weights)
    return shards
