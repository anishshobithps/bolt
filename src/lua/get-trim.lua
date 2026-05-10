local key = KEYS[1]
local max = tonumber(ARGV[1])
redis.call('LTRIM', key, -max, -1)
return redis.call('LRANGE', key, 0, -1)
