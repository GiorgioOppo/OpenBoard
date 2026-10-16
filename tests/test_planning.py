#!/usr/bin/env python3
"""Board-scoped typed metadata and milestone planning, tested through HTTP."""
from concurrent.futures import ThreadPoolExecutor
import copy
import json
import sqlite3
import unittest
from urllib.parse import urlencode
import test_api
import test_auth


class OpenBoardPlanning(unittest.TestCase):
    setUp = test_api.OpenBoardAPI.setUp
    start_server = test_api.OpenBoardAPI.start_server
    stop_server = test_api.OpenBoardAPI.stop_server
    server_log = test_api.OpenBoardAPI.server_log
    request = test_api.OpenBoardAPI.request
    api = test_api.OpenBoardAPI.api
    create_board = test_api.OpenBoardAPI.create_board
    create_card = test_api.OpenBoardAPI.create_card
    board = test_api.OpenBoardAPI.board

    def field(self, board, key, kind="text", **values):
        return self.api("POST", f"/api/boards/{board}/fields", {"key":key,"name":key,"type":kind,**values}, expected=201)["id"]

    def milestone(self, board, key="release", **values):
        return self.api("POST", f"/api/boards/{board}/milestones", {"key":key,"title":"Release",**values}, expected=201)["id"]

    def versions(self, *ids):
        return [{"id":cid,"version":self.api("GET",f"/api/cards/{cid}")["version"]} for cid in ids]

    def test_five_typed_values_merge_clear_detail_summary_and_search(self):
        b=self.create_board();bid=b["id"]
        for key,kind in (("note","text"),("cost","number"),("launch","date"),("approved","boolean"),("region","select")):
            self.field(bid,key,kind,**({"options":["Italia","España"]} if kind=="select" else {}))
        values={"note":"Caffè <script> & \"quote\"","cost":12.5,"launch":"2028-02-29","approved":False,"region":"España"}
        card=self.create_card(b["columns"][0]["id"],"Metadata",custom_values=values)
        self.assertEqual(self.api("GET",f"/api/cards/{card}")["custom_values"],values)
        summary=self.api("GET",f"/api/boards/{bid}?summary=1")["columns"][0]["cards"][0]
        self.assertEqual(summary["custom_values"],values)
        current=self.api("GET",f"/api/cards/{card}/fields")
        self.api("PATCH",f"/api/cards/{card}/fields",{"values":{"cost":19,"note":None}},headers={"If-Match":str(current["version"])})
        expected={**values,"cost":19};expected.pop("note")
        self.assertEqual(self.api("GET",f"/api/cards/{card}/fields")["values"],expected)
        self.api("PATCH",f"/api/cards/{card}/fields",{"values":{"cost":20}},expected=412,headers={"If-Match":str(current["version"])})
        self.api("PATCH",f"/api/cards/{card}/fields",{"values":{"note":"☕"*2000}})
        self.api("PATCH",f"/api/cards/{card}/fields",{"values":{"note":None}})
        for key,value in expected.items():
            found=self.api("GET",f"/api/boards/{bid}/field-search?"+urlencode({"key":key,"value":json.dumps(value,ensure_ascii=False)}))["cards"]
            self.assertEqual([x["id"] for x in found],[card])
        self.api("GET",f"/api/boards/{bid}/field-search?key=cost&value=notjson",expected=400)
        self.api("GET",f"/api/boards/{bid}/field-search?key=x%22%3Bdrop&value=1",expected=400)

    def test_type_bounds_and_unknown_keys_rollback_whole_card(self):
        b=self.create_board();bid=b["id"]
        self.field(bid,"text");self.field(bid,"cost","number");self.field(bid,"date","date");self.field(bid,"flag","boolean");self.field(bid,"choice","select",options=["A","B"])
        card=self.create_card(b["columns"][0]["id"],"Original")
        before=self.api("GET",f"/api/cards/{card}")
        for invalid in ({"unknown":"x"},{"text":1},{"text":"x"*2001},{"text":"\0"},{"cost":"12"},{"cost":1e13},{"date":"2027-02-29"},{"date":""},{"date":"2028-02-29\0evil"},{"flag":1},{"flag":"true"},{"choice":"C"},{"choice":[]},{"text":{}}, {"unknown":None}):
            self.api("PATCH",f"/api/cards/{card}",{"title":"Changed","custom_values":invalid},expected=400)
            self.assertEqual(self.api("GET",f"/api/cards/{card}"),before)
        raw=b'{"values":{"cost":1e999}}'
        self.assertEqual(self.request("PATCH",f"/api/cards/{card}/fields",raw,{"Content-Type":"application/json"})[0],400)
        raw=b'{"values":{"text":"a","text":"b"}}'
        self.assertEqual(self.request("PATCH",f"/api/cards/{card}/fields",raw,{"Content-Type":"application/json"})[0],400)

    def test_definition_rename_reorder_trash_restore_and_unique_keys(self):
        b=self.create_board();bid=b["id"]
        first=self.field(bid,"first");second=self.field(bid,"second")
        self.api("PATCH",f"/api/fields/{second}",{"name":"Secondo ☕","position":0})
        fields=self.api("GET",f"/api/boards/{bid}/fields")["fields"]
        self.assertEqual([x["id"] for x in fields],[second,first]);self.assertEqual(fields[0]["name"],"Secondo ☕")
        self.api("PATCH",f"/api/fields/{second}",{"type":"number"},expected=400)
        self.api("PATCH",f"/api/fields/{second}",{"key":"different"},expected=400)
        self.api("DELETE",f"/api/fields/{first}")
        self.assertEqual(len(self.api("GET",f"/api/boards/{bid}/fields")["fields"]),1)
        self.assertEqual(len(self.api("GET",f"/api/boards/{bid}/fields?include_deleted=1")["fields"]),2)
        self.api("POST",f"/api/boards/{bid}/fields",{"key":"first","name":"Conflict","type":"text"},expected=409)
        self.api("POST",f"/api/fields/{first}/restore",{})
        for invalid in ({"key":"a.b","name":"Bad","type":"text"},{"key":"A","name":"Bad","type":"text"},{"key":"fine","name":" ","type":"text"},{"key":"fine","name":"Bad","type":"select","options":[]},{"key":"fine","name":"Bad","type":"select","options":["A","A"]},{"key":"fine","name":"Bad","type":"select","options":["x"*101]},{"key":"fine","name":"Bad","type":"number","options":["A"]}):
            self.api("POST",f"/api/boards/{bid}/fields",invalid,expected=400)

    def test_field_limit_restore_and_concurrent_unique_definition(self):
        bid=self.create_board()["id"]
        def add(_):
            return self.request("POST",f"/api/boards/{bid}/fields",json.dumps({"key":"same","name":"Same","type":"text"}).encode(),{"Content-Type":"application/json"})[0]
        with ThreadPoolExecutor(max_workers=2) as pool:self.assertEqual(sorted(pool.map(add,range(2))),[201,409])
        ids=[self.field(bid,f"f_{i}") for i in range(19)]
        self.api("POST",f"/api/boards/{bid}/fields",{"key":"overflow","name":"Extra","type":"text"},expected=409)
        self.api("DELETE",f"/api/fields/{ids[0]}");self.field(bid,"replacement")
        self.api("POST",f"/api/fields/{ids[0]}/restore",{},expected=409)

    def test_milestone_progress_overdue_assignment_and_softdelete(self):
        b=self.create_board();bid=b["id"];mid=self.milestone(bid,due_date="2020-01-01")
        a=self.create_card(b["columns"][0]["id"],"A",milestone_key="release")
        c=self.create_card(b["columns"][0]["id"],"Done",milestone_key="release",completed=True)
        m=self.api("GET",f"/api/boards/{bid}/milestones")["milestones"][0]
        self.assertEqual((m["total"],m["done"],m["overdue"]),(2,1,True))
        self.api("PATCH",f"/api/milestones/{mid}",{"title":"Revised","completed":True,"due_date":"2028-02-29"})
        self.assertEqual(self.api("GET",f"/api/boards/{bid}/milestones?overdue=1")["milestones"],[])
        self.api("PATCH",f"/api/milestones/{mid}",{"completed":False,"due_date":"2020-01-01"})
        self.assertEqual(len(self.api("GET",f"/api/boards/{bid}/milestones?overdue=1")["milestones"]),1)
        self.api("DELETE",f"/api/milestones/{mid}")
        self.api("PATCH",f"/api/cards/{a}",{"description":"Existing hidden assignment remains editable"})
        self.api("PATCH",f"/api/cards/{a}",{"milestone_key":"release"},expected=400)
        self.assertEqual(self.api("GET",f"/api/boards/{bid}/milestones")["milestones"],[])
        self.api("POST",f"/api/milestones/{mid}/restore",{})
        self.api("PATCH",f"/api/cards/{a}",{"milestone_key":""})
        self.assertEqual(self.api("GET",f"/api/boards/{bid}/milestones")["milestones"][0]["total"],1)
        foreign=self.create_board();self.milestone(foreign["id"],key="foreign")
        self.api("PATCH",f"/api/cards/{c}",{"milestone_key":"foreign"},expected=400)
        self.api("PATCH",f"/api/milestones/{mid}",{"due_date":"2027-02-29"},expected=400)

    def test_export_import_duplicate_templates_keep_schema_and_hidden_values(self):
        b=self.create_board(guidelines="## Regole\nCaffè & <script>");bid=b["id"]
        fid=self.field(bid,"hidden");self.field(bid,"flag","boolean");mid=self.milestone(bid)
        card=self.create_card(b["columns"][0]["id"],"Portable",custom_values={"hidden":"retained","flag":False},milestone_key="release")
        self.api("DELETE",f"/api/fields/{fid}");self.api("DELETE",f"/api/milestones/{mid}")
        self.api("PATCH",f"/api/cards/{card}",{"title":"Editable"})
        dup=self.api("POST",f"/api/cards/{card}/duplicate",{},expected=201)["id"]
        detail=self.api("GET",f"/api/cards/{dup}");self.assertEqual(detail["custom_values"],{"flag":False});self.assertEqual(detail["milestone_key"],"")
        exported=self.api("GET",f"/api/boards/{bid}/export")
        imported=self.api("POST","/api/import",exported,expected=201)["id"]
        duplicate=self.api("POST",f"/api/boards/{bid}/duplicate",{},expected=201)["id"]
        template=self.api("POST","/api/templates/boards",{"board_id":bid,"name":"Portable board"},expected=201)["id"]
        instantiated=self.api("POST",f"/api/templates/boards/{template}/instantiate",{},expected=201)["id"]
        for clone_id in (imported,duplicate,instantiated):
            clone=self.board(clone_id);self.assertEqual(clone["guidelines"],b["guidelines"])
            self.assertEqual(clone["columns"][0]["cards"][0]["custom_values"],{"hidden":"retained","flag":False})
            self.assertIsNotNone(clone["custom_fields"][0]["deleted_at"])
            restore=clone["custom_fields"][0]["id"];self.api("POST",f"/api/fields/{restore}/restore",{})
            self.assertEqual(len(self.api("GET",f"/api/boards/{clone_id}/fields")["fields"]),2)
        template=self.api("POST","/api/templates/cards",{"card_id":card,"name":"Portable card"},expected=201)["id"]
        other=self.create_board()["columns"][0]["id"]
        cloned=self.api("POST",f"/api/templates/cards/{template}/instantiate",{"column_id":other},expected=201)["id"]
        self.assertEqual(self.api("GET",f"/api/cards/{cloned}")["custom_values"],{})

    def test_import_invalid_metadata_and_custom_values_roll_back_atomically(self):
        b=self.create_board();self.field(b["id"],"cost","number");self.create_card(b["columns"][0]["id"],"A",custom_values={"cost":5})
        exported=self.api("GET",f"/api/boards/{b['id']}/export")
        before=self.api("GET","/api/boards")
        variants=[]
        bad=copy.deepcopy(exported);bad["board"]["custom_fields"][0]["type"]="broken";variants.append(bad)
        bad=copy.deepcopy(exported);bad["board"]["columns"][0]["cards"][0]["custom_values"]={"unknown":1};variants.append(bad)
        bad=copy.deepcopy(exported);bad["board"]["columns"][0]["cards"][0]["custom_values"]={"cost":"bad"};variants.append(bad)
        bad=copy.deepcopy(exported);bad["board"]["custom_fields"]={};variants.append(bad)
        for bad in variants:
            self.api("POST","/api/import",bad,expected=400);self.assertEqual(self.api("GET","/api/boards"),before)

    def test_v4_migration_backups_and_preserves_existing_cards(self):
        b=self.create_board();card=self.create_card(b["columns"][0]["id"],"Before upgrade",actual_minutes=7)
        self.stop_server()
        with sqlite3.connect(self.db) as connection:
            additions = connection.execute("SELECT type,name FROM sqlite_master WHERE name='sprints' OR name GLOB 'sprint_*' OR name GLOB 'intake_*' ORDER BY CASE type WHEN 'trigger' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END").fetchall()
            for kind, name in additions:
                connection.execute('DROP ' + kind.upper() + ' IF EXISTS "' + name.replace('"', '""') + '"')
            connection.executescript("""
                DROP VIEW ob_board_objects; DROP VIEW ob_card_objects;
                DROP VIEW review_resolved; DROP VIEW review_eligibility;
                DROP TRIGGER review_membership_removed;
                DROP TRIGGER review_membership_role;
                DROP TRIGGER review_user_eligibility;
                DROP TABLE custom_fields; DROP TABLE milestones; DROP TABLE worklogs;
                DROP TABLE comment_reactions; DROP TABLE card_bookmarks;
                DROP TABLE review_events; DROP TABLE review_votes;
                DROP TABLE review_members; DROP TABLE reviews; DROP TABLE saved_reports;
                DROP INDEX comments_parent;
                ALTER TABLE comments DROP COLUMN parent_id;
                ALTER TABLE comments DROP COLUMN pinned;
                ALTER TABLE boards DROP COLUMN guidelines;
                ALTER TABLE cards DROP COLUMN custom_values;
                ALTER TABLE cards DROP COLUMN milestone_key;
                PRAGMA user_version=4;
            """)
        self.start_server()
        detail=self.api("GET",f"/api/cards/{card}")
        self.assertEqual((detail["title"],detail["actual_minutes"],detail["custom_values"],detail["milestone_key"],detail["logged_minutes"]),("Before upgrade",7,{},"",0))
        with sqlite3.connect(self.db) as connection:self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0],7)
        backup=self.db.with_name(self.db.name+".pre-v4.bak")
        self.assertTrue(backup.exists())
        with sqlite3.connect(backup) as connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0],4)
            self.assertEqual(connection.execute("SELECT title FROM cards WHERE id=?",(card,)).fetchone()[0],"Before upgrade")
        self.assertEqual(backup.stat().st_mode&0o777,0o600)

    def test_workload_counts_logged_time_once_and_deleted_prerequisites(self):
        b=self.create_board();bid=b["id"];col=b["columns"][0]["id"]
        prerequisite=self.create_card(col,"Dependency",completed=True)
        card=self.create_card(col,"Report",actual_minutes=10,estimate_minutes=90)
        self.api("POST",f"/api/cards/{card}/dependencies",{"required_card_id":prerequisite},expected=201)
        log=self.api("POST",f"/api/cards/{card}/worklogs",{"date":"2026-10-16","minutes":25,"note":"Review"},expected=201)["id"]
        detail=self.api("GET",f"/api/cards/{card}")
        self.assertEqual((detail["actual_minutes"],detail["logged_minutes"],detail["total_minutes"]),(10,25,35))
        workload=self.api("GET",f"/api/boards/{bid}/workload")
        self.assertEqual((workload["actual_minutes"],workload["logged_minutes"],workload["total_minutes"],workload["blocked"]),(10,25,35,0))
        other_col=b["columns"][1]["id"]
        self.api("PATCH",f"/api/cards/{prerequisite}",{"column_id":other_col})
        self.api("DELETE",f"/api/columns/{other_col}")
        self.assertEqual(self.api("GET",f"/api/boards/{bid}/workload")["blocked"],1)
        self.api("PATCH",f"/api/cards/{card}",{"completed":True},expected=409)
        self.api("POST",f"/api/columns/{other_col}/restore",{})
        self.assertEqual(self.api("GET",f"/api/boards/{bid}/workload")["blocked"],0)
        self.api("DELETE",f"/api/cards/{prerequisite}")
        self.assertEqual(self.api("GET",f"/api/boards/{bid}/workload")["blocked"],1)
        self.api("DELETE",f"/api/worklogs/{log}")
        self.assertEqual(self.api("GET",f"/api/boards/{bid}/workload")["total_minutes"],10)
        self.api("POST",f"/api/worklogs/{log}/restore",{})
        self.assertEqual(self.api("GET",f"/api/boards/{bid}/workload")["total_minutes"],35)

    def test_bulk_planning_versions_and_workload_totals(self):
        b=self.create_board();bid=b["id"];self.milestone(bid)
        a=self.create_card(b["columns"][0]["id"],"A",estimate_minutes=60,actual_minutes=20,blocked_reason="Review")
        c=self.create_card(b["columns"][0]["id"],"B",estimate_minutes=90,actual_minutes=10,completed=True)
        batch=self.versions(a,c)
        self.api("POST",f"/api/boards/{bid}/bulk",{"action":"priority","value":"urgent","cards":batch})
        self.api("POST",f"/api/boards/{bid}/bulk",{"action":"milestone","value":"release","cards":batch},expected=412)
        self.api("POST",f"/api/boards/{bid}/bulk",{"action":"labels","value":["design","ricerca"],"cards":self.versions(a,c)})
        self.api("POST",f"/api/boards/{bid}/bulk",{"action":"milestone","value":"release","cards":self.versions(a,c)})
        for cid in (a,c):
            detail=self.api("GET",f"/api/cards/{cid}");self.assertEqual(detail["priority"],"urgent");self.assertEqual(detail["label"],"design");self.assertEqual(detail["milestone_key"],"release")
        workload=self.api("GET",f"/api/boards/{bid}/workload")
        self.assertEqual((workload["total"],workload["completed"],workload["blocked"],workload["estimate_minutes"],workload["actual_minutes"],workload["total_minutes"]),(2,1,1,150,30,30))
        self.assertEqual(workload["by_priority"],{"urgent":2});self.assertEqual(workload["by_milestone"][0]["key"],"release")
        for action,value in (("labels",["bad"]),("labels","design"),("priority","invalid"),("milestone","missing")):
            self.api("POST",f"/api/boards/{bid}/bulk",{"action":action,"value":value,"cards":self.versions(a,c)},expected=400)
        self.api("PATCH",f"/api/boards/{bid}",{"guidelines":"x"*10001},expected=400)
        self.stop_server();self.start_server();self.assertEqual(self.api("GET",f"/api/boards/{bid}/workload")["total_minutes"],30)


class OpenBoardPlanningAuth(unittest.TestCase):
    setUp = test_auth.OpenBoardAuth.setUp
    stop = test_auth.OpenBoardAuth.stop
    read_log = test_auth.OpenBoardAuth.read_log
    request = test_auth.OpenBoardAuth.request
    api = test_auth.OpenBoardAuth.api
    session = test_auth.OpenBoardAuth.session
    add_user = test_auth.OpenBoardAuth.add_user
    login = test_auth.OpenBoardAuth.login
    sql = test_auth.OpenBoardAuth.sql

    def test_planning_read_isolation_and_observer_cannot_write(self):
        viewer=self.add_user("viewer","observer");self.add_user("outsider");self.login("viewer");self.login("outsider")
        self.api("POST","/api/boards/1/members",{"user_id":viewer,"role":"observer"})
        field,_=self.api("POST","/api/boards/1/fields",{"key":"private","name":"Private","type":"text"},expected=201)
        milestone,_=self.api("POST","/api/boards/1/milestones",{"key":"release","title":"Release"},expected=201)
        for path in ("/api/boards/1/fields","/api/boards/1/milestones","/api/boards/1/workload","/api/cards/1/fields","/api/boards/1/field-search?key=private&value=%22x%22"):
            self.api("GET",path,actor="viewer");self.api("GET",path,actor="outsider",expected=404)
        for method,path,payload in (("POST","/api/boards/1/fields",{"key":"new","name":"New","type":"text"}),("PATCH",f"/api/fields/{field['id']}",{"name":"Changed"}),("DELETE",f"/api/milestones/{milestone['id']}",None),("PATCH","/api/cards/1/fields",{"values":{"private":"x"}}),("PATCH","/api/boards/1",{"guidelines":"x"})):
            self.api(method,path,payload,actor="viewer",expected=403)

if __name__=="__main__":unittest.main()
