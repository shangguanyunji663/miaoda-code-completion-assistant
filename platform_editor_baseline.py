#!/usr/bin/env python
#-*- coding:utf-8 -*-

import uuid
import time
import redis

conn = redis.Redis()

# 获得公平信号量
def acquire_fair_semaphore(semname, limit=5, timeout=10):
    # 请在下面完成要求的功能
    #********* Begin *********#
    now = time.time()
    cutoff = now - timeout
    sem_owner = semname + ":owner"
    sem_counter = semname + ":counter"
    identifier = str(uuid.uuid4())
    temp_key = semname + ":temp"

    pipe = conn.pipeline()
    pipe.zremrangebyscore(semname, '-inf', cutoff)
    pipe.zinterstore(temp_key, [sem_owner, semname])
    pipe.delete(sem_owner)
    pipe.rename(temp_key, sem_owner)
    pipe.incr(sem_counter)
    res = pipe.execute()
    counter_val = res[4]

    pipe2 = conn.pipeline()
    pipe2.zadd(sem_owner, identifier, counter_val)
    pipe2.zadd(semname, identifier, now)
    pipe2.zrank(sem_owner, identifier)
    res2 = pipe2.execute()
    rank = res2[2]

    if rank < limit:
        return identifier
    else:
        conn.zrem(sem_owner, identifier)
        conn.zrem(semname, identifier)
        return None
    #********* End *********#

# 释放公平信号量
def release_fair_semaphore(semname, identifier):
    # 请在下面完成要求的功能
    #********* Begin *********#
    sem_owner = semname + ":owner"
    conn.zrem(semname, identifier)
    ret = conn.zrem(sem_owner, identifier)
    return ret
    #********* End *********#