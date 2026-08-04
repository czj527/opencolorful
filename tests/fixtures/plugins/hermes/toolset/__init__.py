# -*- coding: utf-8 -*-
"""Hermes toolset plugin fixture（Phase 12 T7）：L5 worker 调用矩阵。"""

import sys
import time


def hermes_sum(args):
    """成功路径：求和。"""
    a = args.get("a", 0)
    b = args.get("b", 0)
    return {"sum": a + b, "args": args}


def hermes_boom(args):
    """异常路径：抛 ValueError，并先向 stderr 输出标记（验证 stderr 进入诊断）。"""
    sys.stderr.write("hermes-boom-stderr-marker\n")
    sys.stderr.flush()
    raise ValueError("hermes boom failure: " + str(args.get("why", "boom")))


def hermes_slow(args):
    """超时路径：睡 600ms（默认超时 30s，测试覆盖 timeoutMs）。"""
    time.sleep(0.6)
    return {"slow": True}


def hermes_wait(args):
    """取消路径：协作式等待（Host 侧 AbortSignal 拒绝后 worker 继续运行）。"""
    time.sleep(0.5)
    return {"waited": True}


def hermes_crash(args):
    """崩溃路径：非预期退出（触发 worker-crashed 诊断）。"""
    sys.exit(7)


def register(ctx):
    ctx.register_tool(
        name="hermes_sum",
        toolset="hermes",
        schema={
            "type": "object",
            "properties": {
                "a": {"type": "number", "description": "第一个加数"},
                "b": {"type": "number", "description": "第二个加数"},
            },
            "required": ["a", "b"],
        },
        handler=hermes_sum,
        description="Hermes 求和工具",
    )
    ctx.register_tool(
        name="hermes_boom",
        toolset="hermes",
        handler=hermes_boom,
        description="Hermes 抛异常工具",
    )
    ctx.register_tool(
        name="hermes_slow",
        toolset="hermes",
        handler=hermes_slow,
        description="Hermes 慢工具（超时测试）",
    )
    ctx.register_tool(
        name="hermes_wait",
        toolset="hermes",
        handler=hermes_wait,
        description="Hermes 协作取消工具",
    )
    ctx.register_tool(
        name="hermes_crash",
        toolset="hermes",
        handler=hermes_crash,
        description="Hermes 崩溃工具",
    )
