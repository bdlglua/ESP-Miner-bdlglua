#include <assert.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
static void *log_queue=(void *)1;
static bool full,oom;
static unsigned enqueued,depth;
static int emit(const char *,...);
#define ESP_LOGE(tag,...) emit(__VA_ARGS__)
#define ESP_LOGW(tag,...) emit(__VA_ARGS__)
#define pdMS_TO_TICKS(n) (n)
#define pdPASS 1
static const char *TAG="test";
void *__real_calloc(size_t,size_t);
void *__wrap_calloc(size_t n,size_t s){return oom?NULL:__real_calloc(n,s);}
static int xQueueSendToBack(void *q,const void *item,unsigned ticks){
    if(full)return 0;
    char *s=*(char *const *)item;size_t n=strlen(s);assert(n==0||s[n-1]=='\n');
    enqueued++;free(s);return pdPASS;
}
#include "production_log_hook.h"
static int emit(const char *format,...){
    assert(++depth==1); // Errors in a log hook must not re-enter that hook.
    va_list args;va_start(args,format);int result=log_to_queue(format,args);va_end(args);
    depth--;return result;
}
int main(int argc,char **argv){
    assert(argc==2);
    if(!strcmp(argv[1],"full"))full=true;
    if(!strcmp(argv[1],"oom"))oom=true;
    if(full||oom) emit("queue/allocation failure\n");
    else emit("without newline %d",42);
    emit("already terminated\n");emit("");
    if(!full&&!oom){char text[4097];memset(text,'a',sizeof(text)-1);text[sizeof(text)-1]=0;emit("%s",text);assert(enqueued==4);}
    else assert(enqueued==0);
    // The default C locale cannot encode this wide character.
    assert(emit("%lc",(wint_t)0x100)<0);
    puts("PASS: log formatting, buffer bounds and failure paths");
}
