module Api
  # How work is done in this channel. Written by people: a procedure nobody
  # agreed to is not a convention, which is a different question from whether an
  # agent may record a fact.
  class SkillsController < BaseController
    before_action :require_channel_access!

    def index
      render json: Memory::Store.current.skills(channel!).map { |s| serialize(s) }
    end

    def create
      skill = Memory::Store.current.write_skill(
        channel!, title: params.require(:title), body: params.require(:body),
        author: current_user
      )
      Activity.log(actor: current_user, action: "skill.written", subject: nil)
      render json: serialize(skill), status: :created
    end

    private

    def serialize(s) = s.slice(:uri, :title, :overview, :detail)
  end
end
