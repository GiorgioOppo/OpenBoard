/* SPDX-License-Identifier: MIT — isolated Unicode SQL and origin-map checks. */
#include "../../src/unicode.h"
#define UTF8PROC_STATIC
#include "../../vendor/utf8proc/utf8proc.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define CHECK(condition) do { if (!(condition)) { fprintf(stderr,"Unicode fixture failure at line %d\n",__LINE__); exit(1); } } while (0)

static void check_pair(sqlite3 *db, const char *text, const char *query, int expected) {
  sqlite3_stmt *s = NULL;
  CHECK(sqlite3_prepare_v2(db,"SELECT ob_unicode_contains(?1,?2),ob_unicode_snippet(?1,?2)",-1,&s,NULL)==SQLITE_OK);
  CHECK(sqlite3_bind_text(s,1,text,-1,SQLITE_TRANSIENT)==SQLITE_OK);
  CHECK(sqlite3_bind_text(s,2,query,-1,SQLITE_TRANSIENT)==SQLITE_OK);
  CHECK(sqlite3_step(s)==SQLITE_ROW);
  CHECK(sqlite3_column_int(s,0)==expected);
  const unsigned char *snippet=sqlite3_column_text(s,1);
  CHECK(snippet != NULL);
  CHECK(strstr(text,(const char *)snippet)!=NULL);
  sqlite3_finalize(s);
}
static void pairs(sqlite3 *db) {
  const char *yes[][2]={{"Straße","STRASSE"},{"ẞ","ss"},{"Σσς","σσσ"},{"CAFÉ","cafe\xcc\x81"},{"cafe\xcc\x81","CAFÉ"},{"A\xcc\xa7\xcc\x81","Á\xcc\xa7"},{"中文项目","中文"},{"日本語の計画","日本語"},{"𐐀","𐐨"},{"ﬃ","FFI"},{"K","k"},{"ПРИВЕТ","привет"},{"\xe1\x84\x80\xe1\x85\xa1","가"},{"\xc4\xb0","i\xcc\x87"}};
  const char *no[][2]={{"café","cafe"},{"Ё","е"},{"中文","zhongwen"},{"Ａ","a"},{"Ⓐ","a"},{"ø","o"},{"æ","ae"},{"ı","I"}};
  for(size_t i=0;i<sizeof yes/sizeof *yes;++i)check_pair(db,yes[i][0],yes[i][1],1);
  for(size_t i=0;i<sizeof no/sizeof *no;++i)check_pair(db,no[i][0],no[i][1],0);
  check_pair(db,"","needle",0);check_pair(db,"ASCII","",1);
  CHECK(!strcmp(utf8proc_version(),"2.12.0"));CHECK(!strcmp(utf8proc_unicode_version(),"18.0.0"));
}
static void bad_inputs(sqlite3 *db) {
  sqlite3_stmt *s = NULL;
  const unsigned char bad[][4]={{0xc0,0x80,0,0},{0xed,0xa0,0x80,0},{0xf4,0x90,0x80,0x80},{'a',0,'b',0}};
  const int lengths[]={2,3,4,3};
  for(size_t i=0;i<sizeof bad/sizeof *bad;++i) {
    CHECK(sqlite3_prepare_v2(db,"SELECT ob_unicode_contains(?1,'x')",-1,&s,NULL)==SQLITE_OK);
    CHECK(sqlite3_bind_text(s,1,(const char *)bad[i],lengths[i],SQLITE_TRANSIENT)==SQLITE_OK);
    CHECK(sqlite3_step(s)==SQLITE_ERROR);sqlite3_finalize(s);
    CHECK(sqlite3_prepare_v2(db,"SELECT ob_unicode_snippet('x',?1)",-1,&s,NULL)==SQLITE_OK);
    CHECK(sqlite3_bind_text(s,1,(const char *)bad[i],lengths[i],SQLITE_TRANSIENT)==SQLITE_OK);
    CHECK(sqlite3_step(s)==SQLITE_ERROR);sqlite3_finalize(s);
  }
  CHECK(sqlite3_prepare_v2(db,"SELECT ob_unicode_contains(NULL,'x'),ob_unicode_contains('x',NULL),ob_unicode_snippet(NULL,'x')",-1,&s,NULL)==SQLITE_OK);
  CHECK(sqlite3_step(s)==SQLITE_ROW);CHECK(!sqlite3_column_int(s,0));CHECK(!sqlite3_column_int(s,1));CHECK(sqlite3_column_bytes(s,2)==0);sqlite3_finalize(s);
}
static void offset_corpus(sqlite3 *db) {
  unsigned char text[1200], encoded[5];
  for(int i=0;i<300;++i)memcpy(text+i*3,"\xee\x80\x80",3); /* Stable private-use prefix. */
  sqlite3_stmt *s=NULL;
  CHECK(sqlite3_prepare_v2(db,"SELECT ob_unicode_contains(?1,?2),ob_unicode_snippet(?1,?2)",-1,&s,NULL)==SQLITE_OK);
  size_t checked=0;
  for(utf8proc_int32_t cp=1;cp<0x110000;++cp) {
    if(cp>=0xd800 && cp<=0xdfff)continue;
    utf8proc_ssize_t bytes=utf8proc_encode_char(cp,encoded);CHECK(bytes>0);encoded[bytes]=0;
    utf8proc_uint8_t *folded=NULL;
    utf8proc_ssize_t length=utf8proc_map(encoded,bytes,&folded,UTF8PROC_STABLE|UTF8PROC_CASEFOLD|UTF8PROC_COMPOSE);
    CHECK(length>=0);
    if(length==bytes && !memcmp(folded,encoded,(size_t)bytes)) {utf8proc_free(folded);continue;}
    memcpy(text+900,encoded,(size_t)bytes);memcpy(text+900+bytes," tail",6);
    CHECK(sqlite3_bind_text(s,1,(const char *)text,-1,SQLITE_TRANSIENT)==SQLITE_OK);
    CHECK(sqlite3_bind_text(s,2,(const char *)folded,(int)length,SQLITE_TRANSIENT)==SQLITE_OK);
    CHECK(sqlite3_step(s)==SQLITE_ROW);CHECK(sqlite3_column_int(s,0)==1);
    const unsigned char *snippet=sqlite3_column_text(s,1);CHECK(snippet!=NULL);
    CHECK(sqlite3_column_bytes(s,1)==120+bytes+5);
    CHECK(!memcmp(snippet,text+780,(size_t)(120+bytes+5)));
    CHECK(sqlite3_reset(s)==SQLITE_OK);CHECK(sqlite3_clear_bindings(s)==SQLITE_OK);
    utf8proc_free(folded);++checked;
  }
  CHECK(checked>2000);sqlite3_finalize(s);
  printf("Original offsets verified for %zu changed Unicode scalar mappings.\n",checked);
}
static void long_cluster(sqlite3 *db) {
  char text[2500];memset(text,'x',300);text[300]='a';
  for(int i=0;i<1000;++i)memcpy(text+301+i*2,"\xcc\x81",2);
  memcpy(text+2301,"\xcc\x95 tail",8);
  sqlite3_stmt *s=NULL;
  CHECK(sqlite3_prepare_v2(db,"SELECT ob_unicode_snippet(?1,?2)",-1,&s,NULL)==SQLITE_OK);
  sqlite3_bind_text(s,1,text,-1,SQLITE_TRANSIENT);sqlite3_bind_text(s,2,"\xcc\x95",-1,SQLITE_STATIC);
  CHECK(sqlite3_step(s)==SQLITE_ROW);
  const char *snippet=(const char *)sqlite3_column_text(s,0);CHECK(snippet && strstr(snippet,"\xcc\x95 tail"));
  CHECK(sqlite3_column_bytes(s,0)==87);sqlite3_finalize(s);
}
int main(void) {
  sqlite3 *db=NULL;CHECK(sqlite3_open(":memory:",&db)==SQLITE_OK);CHECK(ob_unicode_register(db)==SQLITE_OK);
  pairs(db);bad_inputs(db);offset_corpus(db);long_cluster(db);CHECK(sqlite3_close(db)==SQLITE_OK);
  puts("Unicode SQL fixture passed.");return 0;
}
