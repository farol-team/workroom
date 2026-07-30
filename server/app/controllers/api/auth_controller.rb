module Api
  # Development sign-in. Replaced by OmniAuth; the shape of what it returns
  # (a bearer token identifying a User) does not change.
  class AuthController < BaseController
    skip_before_action :authenticate!

    def create
      email = params.require(:email).to_s.downcase
      user = User.find_or_create_by!(email:, provider: "dev", uid: email) do |u|
        u.name = params[:name].presence || email.split("@").first.titleize
      end
      user.update!(api_token: SecureRandom.hex(24)) if user.api_token.blank?
      render json: { token: user.api_token, user: user.slice(:id, :email, :name) }
    end
  end
end
