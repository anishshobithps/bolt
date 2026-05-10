local key = KEYS[1]
local max = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cutoff = now - window
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
local count = tonumber(redis.call('ZCARD', key))
if count >= max then
    return 0
end
redis.call('ZADD', key, now, now .. ':' .. count)
redis.call('EXPIRE', key, window)
return 1
