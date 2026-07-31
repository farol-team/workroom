module Api
  # Work product belongs to the channel, not to the laptop that made it
  # (Article D3).
  #
  # Attaching is deliberate. A transcript is stored as a file and nothing else:
  # it does not reach distillation, so an attachment cannot become an injection
  # into every later session's context.
  class ArtifactsController < BaseController
    before_action :require_channel_access!, only: :index

    def index
      render json: channel!.artifacts.order(created_at: :desc).map { |a| serialize(a) }
    end

    def create
      run = AgentRun.joins(:agent_session)
                    .where(agent_sessions: { user_id: current_user.id })
                    .find(params[:run_id])

      artifact = run.agent_session.channel.artifacts.create!(
        agent_run: run, name: params.require(:name), kind: params[:kind]
      )
      artifact.file.attach(io: StringIO.new(params.require(:content)),
                           filename: artifact.name,
                           content_type: params[:content_type] || "application/json")

      Activity.log(actor: current_user, action: "artifact.attached", subject: artifact)
      Broadcast.artifact(artifact)
      render json: serialize(artifact), status: :created
    end

    private

    def serialize(a)
      a.slice(:id, :name, :kind, :created_at)
       .merge(run_id: a.agent_run_id, bytes: a.file.attached? ? a.file.byte_size : 0)
    end
  end
end
