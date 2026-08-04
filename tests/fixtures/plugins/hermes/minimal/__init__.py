# -*- coding: utf-8 -*-
"""Hermes minimal plugin fixture（Phase 12 T7）。"""

import os


def hermes_greet(args):
    """Hermes 最小工具：问候。"""
    name = args.get("name", "world")
    return {"greeting": "hello " + str(name), "pid": os.getpid()}


def register(ctx):
    ctx.register_tool(
        name="hermes_greet",
        toolset="hermes",
        schema={
            "type": "object",
            "properties": {"name": {"type": "string", "description": "名字"}},
            "required": [],
        },
        handler=hermes_greet,
        description="Hermes 最小工具：问候",
    )
