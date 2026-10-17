#!/usr/bin/env python3
"""Typed custom-field comparisons, bounded combinations, pagination and ACLs."""
import json
import sqlite3
import unittest
from urllib.parse import urlencode
import test_api
import test_auth
import test_planning


class OpenBoardFieldFilters(unittest.TestCase):
    setUp = test_api.OpenBoardAPI.setUp
    start_server = test_api.OpenBoardAPI.start_server
    stop_server = test_api.OpenBoardAPI.stop_server
    server_log = test_api.OpenBoardAPI.server_log
    request = test_api.OpenBoardAPI.request
    api = test_api.OpenBoardAPI.api
    create_board = test_api.OpenBoardAPI.create_board
    create_card = test_api.OpenBoardAPI.create_card
    board = test_api.OpenBoardAPI.board
    field = test_planning.OpenBoardPlanning.field

    def search(self, board, expected=200, **query):
        return self.api("GET", f"/api/boards/{board}/field-search?" + urlencode(query), expected=expected)

    def ids(self, board, **query):
        return [card["id"] for card in self.search(board, **query)["cards"]]

    def test_typed_operators_and_legacy_exact_match(self):
        board = self.create_board(); bid = board["id"]; col = board["columns"][0]["id"]
        for key, kind in (("cost", "number"), ("launch", "date"), ("flag", "boolean"), ("note", "text"), ("region", "select")):
            self.field(bid, key, kind, **({"options": ["España", "Italia"]} if kind == "select" else {}))
        a = self.create_card(col, "A", custom_values={"cost": 10, "launch": "2028-02-29", "flag": False, "note": "Caffè ☕", "region": "España"})
        b = self.create_card(col, "B", custom_values={"cost": 20.5, "launch": "2028-03-01", "flag": True, "note": "CAFFÈ ☕", "region": "Italia"})
        for op, target, result in (("eq", 10.0, [a]), ("ne", 10, [b]), ("gt", 10, [b]), ("gte", 10, [b,a]), ("lt", 20.5, [a]), ("lte", 10, [a])):
            self.assertEqual(self.ids(bid, key="cost", op=op, value=json.dumps(target)), result)
        self.assertEqual(self.ids(bid, key="cost", value="10"), [a])
        self.assertEqual(self.ids(bid, key="launch", op="gte", value='"2028-03-01"'), [b])
        self.assertEqual(self.ids(bid, key="flag", value="false"), [a])
        self.assertEqual(self.ids(bid, key="note", op="contains", value='"Caffè"'), [a])
        self.assertEqual(self.ids(bid, key="region", op="contains", value='"paña"'), [a])
        self.assertEqual(self.ids(bid, key="note", op="contains", value=json.dumps("' OR 1=1 --")), [])

    def test_unset_false_zero_empty_and_null_semantics(self):
        board = self.create_board(); bid = board["id"]; col = board["columns"][0]["id"]
        self.field(bid,"cost","number"); self.field(bid,"flag","boolean"); self.field(bid,"note")
        missing = self.create_card(col, "Missing")
        null = self.create_card(col, "Null", custom_values={"cost": None, "note": None})
        zero = self.create_card(col, "Zero", custom_values={"cost": 0, "flag": False, "note": ""})
        # Current writes clear nulls; older JSON can contain an explicit null.
        with sqlite3.connect(self.db) as connection:
            connection.execute('UPDATE cards SET custom_values=\'{"cost":null,"note":null}\' WHERE id=?',(null,))
        self.assertEqual(self.ids(bid, key="cost", op="is_unset"), [null, missing])
        self.assertEqual(self.ids(bid, key="cost", op="is_set"), [zero])
        self.assertEqual(self.ids(bid, key="cost", op="ne", value="1"), [zero])
        self.assertEqual(self.ids(bid, key="cost", op="gte", value="0"), [zero])
        self.assertEqual(self.ids(bid, key="note", op="is_set"), [zero])
        self.assertEqual(self.ids(bid, key="flag", value="false"), [zero])
        # Legacy null equality only finds an explicit JSON null, not a missing key.
        self.assertEqual(self.ids(bid, key="cost", value="null"), [null])
        self.assertEqual(self.ids(bid, key="cost", op="ne", value="null"), [zero])

    def test_flat_all_any_and_missing_values_do_not_bypass_all(self):
        board = self.create_board(); bid=board["id"]; col=board["columns"][0]["id"]
        self.field(bid,"cost","number"); self.field(bid,"flag","boolean")
        a=self.create_card(col,"A",custom_values={"cost":15,"flag":True})
        b=self.create_card(col,"B",custom_values={"cost":5,"flag":True})
        c=self.create_card(col,"C",custom_values={"flag":True})
        filters=json.dumps([{"key":"cost","op":"gte","value":10},{"key":"flag","op":"eq","value":True}])
        self.assertEqual(self.ids(bid,filters=filters),[a])
        self.assertEqual(self.ids(bid,filters=filters,match="any"),[c,b,a])
        self.search(bid,expected=400,filters=filters,key="cost",value="1")
        self.search(bid,expected=400,filters=filters,match="or")
        for invalid in ([], {}, [True], [{"key":"cost","op":"gte","value":10,"extra":1}], [{"key":"cost","op":"eq","value":{"x":1}}], [{"key":"cost","op":"is_set","value":None}], [{"key":"cost","op":"is_set"}]*11):
            self.search(bid,expected=400,filters=json.dumps(invalid,separators=(',',':')))
        self.search(bid,expected=400,filters='[{"key":"cost","key":"flag","op":"is_set"}]')

    def test_rejects_type_coercion_removed_fields_and_bad_query_parameters(self):
        board=self.create_board();bid=board["id"]
        ids={key:self.field(bid,key,kind,**({"options":["A","B"]} if kind=="select" else {})) for key,kind in (("cost","number"),("date","date"),("flag","boolean"),("note","text"),("choice","select"))}
        for key,op,value in (("cost","gt",'"10"'),("cost","eq","1e999"),("cost","eq","1000000000001"),("date","lt",'"2027-02-29"'),("date","eq",'"0000-01-01"'),("flag","eq","1"),("flag","eq",'"false"'),("flag","gt","false"),("note","gt",'"x"'),("choice","eq",'"C"'),("cost","contains",'"1"'),("note","contains",'"a\\u0000b"'),("missing","is_set",None),("cost","xor","1")):
            query={"key":key,"op":op}
            if value is not None:query["value"]=value
            self.search(bid,expected=400,**query)
        for query in ({"key":"cost","op":"is_set","value":"null"},{"key":"cost","op":"eq"},{"key":"cost","value":"1","limit":"0"},{"key":"cost","value":"1","limit":"201"},{"key":"cost","value":"1","before":"01"}):
            self.search(bid,expected=400,**query)
        self.api("GET",f"/api/boards/{bid}/field-search?key=cost&value=1&op=eq&op=ne",expected=400)
        self.api("DELETE",f"/api/fields/{ids['cost']}")
        self.search(bid,expected=400,key="cost",op="is_set")

    def test_pagination_applies_live_ancestry_and_archive_before_limit(self):
        board=self.create_board();bid=board["id"];col=board["columns"][0]["id"]
        self.field(bid,"cost","number")
        a=self.create_card(col,"A",custom_values={"cost":1});b=self.create_card(col,"B",custom_values={"cost":1});c=self.create_card(col,"C",custom_values={"cost":1})
        archived=self.create_card(col,"Archived",custom_values={"cost":1},archived=True)
        deleted=self.create_card(col,"Deleted",custom_values={"cost":1});self.api("DELETE",f"/api/cards/{deleted}")
        dead_col=board["columns"][1]["id"];self.create_card(dead_col,"Dead parent",custom_values={"cost":1});self.api("DELETE",f"/api/columns/{dead_col}")
        first=self.search(bid,key="cost",value="1",limit=2)
        self.assertEqual([x["id"] for x in first["cards"]],[c,b]);self.assertEqual(first["next_cursor"],b)
        second=self.search(bid,key="cost",value="1",limit=2,before=first["next_cursor"])
        self.assertEqual([x["id"] for x in second["cards"]],[a]);self.assertIsNone(second["next_cursor"])
        self.assertEqual(self.ids(bid,key="cost",value="1",include_archived=1),[archived,c,b,a])
        self.api("PATCH",f"/api/boards/{bid}",{"archived":True})
        self.assertEqual(self.ids(bid,key="cost",value="1"),[])
        self.assertEqual(self.ids(bid,key="cost",value="1",include_archived=1),[archived,c,b,a])
        self.api("DELETE",f"/api/boards/{bid}")
        self.search(bid,expected=404,key="cost",value="1")


class OpenBoardFieldFiltersAuth(unittest.TestCase):
    setUp=test_auth.OpenBoardAuth.setUp
    stop=test_auth.OpenBoardAuth.stop
    read_log=test_auth.OpenBoardAuth.read_log
    request=test_auth.OpenBoardAuth.request
    api=test_auth.OpenBoardAuth.api
    session=test_auth.OpenBoardAuth.session
    add_user=test_auth.OpenBoardAuth.add_user
    login=test_auth.OpenBoardAuth.login
    sql=test_auth.OpenBoardAuth.sql

    def test_observer_reads_outsider_and_revoked_member_cannot_probe(self):
        viewer=self.add_user("viewer","observer");self.add_user("outsider");self.login("viewer");self.login("outsider")
        self.api("POST","/api/boards/1/members",{"user_id":viewer,"role":"observer"})
        self.api("POST","/api/boards/1/fields",{"key":"secret","name":"Secret","type":"number"},expected=201)
        self.api("PATCH","/api/cards/1",{"custom_values":{"secret":25}})
        path="/api/boards/1/field-search?"+urlencode({"filters":json.dumps([{"key":"secret","op":"gte","value":20}]),"limit":1})
        found,_=self.api("GET",path,actor="viewer");self.assertEqual(found["cards"][0]["id"],1)
        self.api("GET",path,actor="outsider",expected=404)
        self.api("GET",path,actor=None,expected=401)
        self.api("DELETE",f"/api/boards/1/members/{viewer}")
        self.api("GET",path,actor="viewer",expected=404)
        self.api("GET","/api/boards/1/field-search?key=unknown&op=is_set",actor="viewer",expected=404)


if __name__=="__main__":unittest.main()
