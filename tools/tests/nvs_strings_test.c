#include <assert.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "../../main/nvs_config.c"

static ConfigUpdate queued;
static pthread_t reader_thread;
static atomic_int intercept, writer_attempted, writer_done;
static int read_mode;
char *__real_strdup(const char *);
int __real_strcmp(const char *, const char *);

// Hold a reader inside the actual copy/compare while the real NVS task replaces
// the string. Before the fix the writer frees that reader's pointer here.
static void overlap_writer(void) {
    if (!atomic_exchange(&intercept, 0)) return;
    atomic_store(&writer_attempted, 1);
    for (int n=0; n<100 && !atomic_load(&writer_done); n++) usleep(1000);
}
char *__wrap_strdup(const char *s) {
    if (read_mode && pthread_equal(pthread_self(),reader_thread)) overlap_writer();
    return __real_strdup(s);
}
int __wrap_strcmp(const char *a,const char *b) {
    if (!read_mode && pthread_equal(pthread_self(),reader_thread)) overlap_writer();
    return __real_strcmp(a,b);
}
int xQueueReceive(QueueHandle_t q,void *out,unsigned ticks) {
    static int count;
    if (count++) {atomic_store(&writer_done,1);pthread_exit(NULL);}
    while (!atomic_load(&writer_attempted)) usleep(100);
    memcpy(out,&queued,sizeof(queued)); return pdTRUE;
}
int xQueueSend(QueueHandle_t q,const void *data,unsigned ticks) {
    // No second worker is needed; exercise setter ownership without leaking.
    const ConfigUpdate *update=data; if(update->type==TYPE_STR)free(update->value.str);
    return pdPASS;
}
int nvs_set_str(nvs_handle_t h,const char *key,const char *v) {assert(v);return ESP_OK;}
int nvs_set_u16(nvs_handle_t h,const char *k,uint16_t v){return ESP_OK;}
int nvs_set_i32(nvs_handle_t h,const char *k,int32_t v){return ESP_OK;}
int nvs_set_u64(nvs_handle_t h,const char *k,uint64_t v){return ESP_OK;}
int nvs_commit(nvs_handle_t h){return ESP_OK;}
static void *writer(void *unused) {nvs_task(NULL);return NULL;}
static void *reader(void *unused) {
    reader_thread=pthread_self();atomic_store(&intercept,1);
    if(read_mode){char *s=nvs_config_get_string(NVS_CONFIG_FALLBACK_STRATUM_USER);assert(s&&!strcmp(s,"original-account"));free(s);}
    else nvs_config_set_string(NVS_CONFIG_FALLBACK_STRATUM_USER,"third-account");
    return NULL;
}
int main(int argc,char **argv) {
    assert(argc==2);read_mode=!strcmp(argv[1],"read");
    settings[NVS_CONFIG_FALLBACK_STRATUM_USER].value.str=strdup("original-account");
    queued=(ConfigUpdate){.key=NVS_CONFIG_FALLBACK_STRATUM_USER,.type=TYPE_STR,.value.str=strdup("replacement-account")};
    pthread_t w,r;assert(!pthread_create(&w,NULL,writer,NULL));assert(!pthread_create(&r,NULL,reader,NULL));
    assert(!pthread_join(r,NULL));assert(!pthread_join(w,NULL));
    assert(!strcmp(settings[NVS_CONFIG_FALLBACK_STRATUM_USER].value.str,"replacement-account"));
    free(settings[NVS_CONFIG_FALLBACK_STRATUM_USER].value.str);
    puts("PASS: concurrent NVS string replacement preserves reader lifetime");
}
