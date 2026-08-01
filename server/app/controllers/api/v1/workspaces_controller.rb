module Api
  module V1
    # Making a room, and seeing which ones you are in.
    #
    # Anybody signed in may make one and owns it. Requiring an existing owner to
    # create somebody else's first room is a support ticket rather than a
    # boundary — and the boundary that matters is between rooms, which #118 built
    # and the database keeps.
    class WorkspacesController < BaseController
      def index
        render json: current_user.workspace_memberships.includes(:workspace).map { |m|
          # No token. One that reaches another room, handed over by a request
          # authenticated for this one, is the escalation the boundary exists to
          # prevent — see #150.
          serialize(m.workspace).merge(role: m.role)
        }
      end

      def create
        workspace = Workspace.new(slug: params.require(:slug).to_s.downcase,
                                  name: params.require(:name))
        return render_error(workspace.errors.full_messages.join(", "), :unprocessable_entity) \
          unless workspace.save

        membership = WorkspaceMembership.create!(user: current_user, workspace:, role: "owner")
        provision(workspace)
        workspace.open_first_rooms(owner: current_user)

        # The token comes back because the caller just made this room. Nothing
        # else hands one over.
        render json: serialize(workspace).merge(role: membership.role, token: membership.api_token),
               status: :created
      end

      private

      def serialize(workspace)
        workspace.slice(:id, :slug, :name)
                 .merge(has_own_context_store: workspace.openviking_url.present?)
      end

      # A room without its own account shares whatever the environment names,
      # which is the leak #140 closed for PostgreSQL. Issued where the server
      # holds the key to issue one, and skipped — loudly in the log, not silently
      # — where it does not.
      def provision(workspace)
        url = ENV["OPENVIKING_URL"].presence
        root = ENV["OPENVIKING_ROOT_KEY"].presence
        return Rails.logger.info("#{workspace.slug} shares the configured context store") unless url && root

        Memory::Provision.new(url:, root_key: root).call(workspace)
      rescue Memory::Provision::Error => e
        # The room exists and works; what it lacks is its own store. Saying so is
        # better than refusing a room somebody has already been told they have.
        Rails.logger.error("#{workspace.slug} has no context store of its own: #{e.message}")
      end
    end
  end
end
