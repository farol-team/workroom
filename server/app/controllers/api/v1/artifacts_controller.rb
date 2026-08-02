module Api
  module V1
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

        body = content!
        channel = run.agent_session.channel

        # The bytes go to the record store and the row keeps their address. Two
        # uploads of the same file are one object and two rows, which is what
        # addressing content rather than locations buys.
        artifact = channel.artifacts.create!(
          agent_run: run, name: params.require(:name), kind: params[:kind],
          sha256: RecordStore::Objects.current.put(body), byte_size: body.bytesize,
          content_type: params[:content_type] || "application/json"
        )

        # In the same transaction as the row, so a file the journal could not
        # record does not exist: half a record is a room whose history has a
        # hole in it that nothing marks.
        RecordStore::Append.call(
          channel:, kind: "artifact", subject: artifact,
          payload: artifact.slice(:name, :kind, :sha256, :byte_size, :content_type)
                           .merge(run_id: run.id)
        )

        Activity.log(actor: current_user, action: "artifact.attached", subject: artifact)
        Broadcast.artifact(artifact)
        render json: serialize(artifact), status: :created
      end

      private

      # Work product is not always text. A chart sent as a string arrives
      # corrupted and nothing complains, so bytes travel base64 and text does not
      # have to.
      def content!
        return params[:content] if params[:content].present?

        encoded = params[:content_base64]
        raise ActionController::ParameterMissing, :content if encoded.blank?

        Base64.strict_decode64(encoded)
      rescue ArgumentError
        raise ActionController::BadRequest, "content_base64 is not base64"
      end

      # sha256 is sent even when it is empty: an artifact from before the record
      # store has its bytes in an attachment and no address, and a client has to
      # be able to tell that from a server that does not send the field. Its
      # size still comes from where its bytes actually are.
      def serialize(a)
        a.slice(:id, :name, :kind, :sha256, :created_at)
         .merge(run_id: a.agent_run_id, bytes: a.byte_size || (a.file.attached? ? a.file.byte_size : 0))
      end
    end
  end
end
