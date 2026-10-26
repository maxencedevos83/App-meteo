package fr.maxence.meteo

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import kotlin.concurrent.thread

/**
 * Vérification des alertes toutes les 15 min en arrière-plan, même si le widget n'est pas sur l'écran
 * (Android peut espacer les passages quand le téléphone est en veille prolongée).
 */
class AlertJob : JobService() {

    override fun onStartJob(params: JobParameters): Boolean {
        thread {
            try {
                val data = MeteoData.refresh(this)
                MeteoWidget.render(this, data)
                if (MeteoData.lastError(this) == null) Notifier.notifyNew(this, data)
            } finally {
                jobFinished(params, false)
            }
        }
        return true
    }

    override fun onStopJob(params: JobParameters) = true

    companion object {
        private const val ID = 4242

        fun schedule(context: Context) {
            val scheduler = context.getSystemService(JobScheduler::class.java)
            if (scheduler.getPendingJob(ID) != null) return
            scheduler.schedule(
                JobInfo.Builder(ID, ComponentName(context, AlertJob::class.java))
                    .setPeriodic(15 * 60 * 1000L)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPersisted(true)
                    .build(),
            )
        }
    }
}
