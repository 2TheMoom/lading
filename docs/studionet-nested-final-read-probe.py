# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *
from genlayer.py.public_abi import StorageType


class Probe(gl.Contract):
    target: Address
    seen: u256

    def __init__(self, target: str):
        self.target = Address(target)

    @gl.public.view
    def read_default(self) -> int:
        return int(gl.get_contract_at(self.target).view().get_count())

    @gl.public.view
    def read_final(self) -> int:
        return int(gl.get_contract_at(self.target).view(state=StorageType.LATEST_FINAL).get_count())

    @gl.public.write
    def write_default(self) -> None:
        self.seen = gl.get_contract_at(self.target).view().get_count()

    @gl.public.write
    def write_final(self) -> None:
        self.seen = gl.get_contract_at(self.target).view(state=StorageType.LATEST_FINAL).get_count()

    @gl.public.view
    def get_seen(self) -> int:
        return int(self.seen)
